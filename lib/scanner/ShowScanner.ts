import fs from "fs/promises";
import Path, { ParsedPath } from "path";
import { FfProbeInfo, getInfo } from "../util/ffprobe";
import { Scanner } from "./models";
import { FFProbeStream } from "ffprobe";
import { Dirent } from "fs";
import { Database, hash } from "@rewind-media/rewind-common";
import { CronLogger } from "../log";
import { Library, ShowSeasonInfo } from "@rewind-media/rewind-protocol";
import { first, sum, any, max, flow, identity, filter, map } from "lodash/fp";

const log = CronLogger.getChildCategory("ShowScanner");

// const sum = reduce((acc, element) => acc + element, 0);

const isVideoStream = any(
  (it: FFProbeStream) => it.codec_type?.toLowerCase() == "video"
);

function extractDuration(ffProbeInfo: FfProbeInfo): number {
  return (
    max(
      flow(
        map<FFProbeStream, number | undefined>((it) => it.duration),
        filter<number>(identity)
      )(ffProbeInfo.streams)
    ) ?? 0
  );
}

function isVideo(ffProbeInfo: FfProbeInfo) {
  return (
    ffProbeInfo.streams.length > 0 &&
    isVideoStream(ffProbeInfo.streams) &&
    1 <= extractDuration(ffProbeInfo)
  );
}

export class ShowScanner extends Scanner {
  constructor(library: Library, db: Database) {
    super(library, db);
  }

  scan(): Promise<number> {
    const start = new Date();
    return Promise.all(
      this.library.rootPaths.map((rootPath) => {
        log.info(`Scanning ${rootPath}`);
        return fs
          .readdir(rootPath, { withFileTypes: true })
          .then((dirEntries) =>
            Promise.all(
              dirEntries
                .filter((dirEntry) => dirEntry.isDirectory())
                .map((dirEntry) => this.scanShow(dirEntry.name, rootPath))
            )
          )
          .then(sum);
      })
    )
      .then(sum)
      .then((upsertedRows) =>
        this.db
          .cleanShowEpisodes(start, this.library.name)
          .then(() =>
            Promise.all([
              this.db.cleanShowSeasons(start, this.library.name),
              this.db.cleanShows(start, this.library.name),
              this.db.cleanImages(start, this.library.name), // image file resources (season images, etc)
            ])
          )
          .then(() => upsertedRows)
      )
      .then((it) => {
        log.info(`Finished scanning ${this.library.name}`);
        return it;
      })
      .catch((reason) => {
        log.error(`Error scanning library ${this.library.name}: ${reason}`);
        return 0;
      });
  }

  private scanShow(showName: string, rootPath: string): Promise<number> {
    const path = Path.resolve(rootPath, showName);
    const showId = hash.mkFileId(path, this.library.name);
    return fs
      .readdir(path, { withFileTypes: true })
      .then((dirEntries) =>
        Promise.all(
          dirEntries
            .filter((dirEntry) => dirEntry.isDirectory())
            .map((dirEntry) =>
              this.scanSeason(showId, Path.resolve(path, dirEntry.name))
            )
        )
      )
      .then(sum)
      .then((count) => {
        if (count > 0) {
          return this.db
            .upsertShow({
              id: showId,
              showName: showName,
              libraryName: this.library.name,
            })
            .then(() => count);
        } else {
          return new Promise<number>((resolve, reject) => resolve(count));
        }
      })
      .catch((reason) => {
        log.error(
          `Error scanning show in ${this.library.name}: ${rootPath}/${showName}: ${reason}`
        );
        return 0;
      });
  }

  private scanSeason(showId: string, seasonPath: string): Promise<number> {
    const seasonId = hash.mkFileId(seasonPath, this.library.name);
    return this.separateSeasonFiles(seasonPath).then(
      ({ metadataFiles, dataFiles }) =>
        Promise.all(
          dataFiles.episodeFiles.map((episodeFileSet) => {
            return this.db
              .upsertShowEpisode({
                id: hash.mkFileId(
                  episodeFileSet.video.dirent.name,
                  this.library.name
                ),
                name: episodeFileSet.baseName,
                showId: showId,
                seasonId: seasonId,
                lastUpdated: new Date(),
                path: Path.resolve(
                  seasonPath,
                  episodeFileSet.video.dirent.name
                ),
                libraryName: this.library.name,
                info: episodeFileSet.video.ffProbeInfo,
              })
              .then((res) => (res ? 1 : 0));
          })
        )
          .then(sum)
          .then((count) => {
            return new Promise<number>((resolve, reject) => {
              if (count > 0) {
                return this.persistSeasonMetadata(
                  showId,
                  seasonPath,
                  seasonId,
                  metadataFiles
                )
                  .catch((e) =>
                    log.error(`Error persisting season metadata ${e}`)
                  )
                  .then(() => resolve(count));
              } else {
                resolve(count);
              }
            });
          })
    );
  }

  persistSeasonMetadata(
    showId: string,
    seasonPath: string,
    seasonId: string,
    metadataFiles: MetadataFiles
  ): Promise<ShowSeasonInfo> {
    const seasonName = Path.parse(seasonPath).name;

    const folderImageInfo = metadataFiles.folderImage
      ? this.mkFolderImageInfo(metadataFiles.folderImage, seasonPath)
      : null;
    const folderImageProm = folderImageInfo
      ? this.db.upsertImage(folderImageInfo)
      : null;

    return Promise.all(filter(identity)([folderImageProm])).then((it) => {
      const showSeasonInfo = {
        showId: showId,
        seasonName: seasonName,
        libraryName: this.library.name,
        id: hash.mkFileId(seasonPath, this.library.name),
        folderImageId: folderImageInfo?.id,
      };

      return this.db.upsertShowSeason(showSeasonInfo).then((it) => {
        if (it) {
          return showSeasonInfo;
        } else {
          throw Error(
            "Failed to upsert show season in database" +
              JSON.stringify(showSeasonInfo)
          );
        }
      });
    });
  }

  private mkFolderImageInfo(folderImage: Dirent, seasonPath: string) {
    const path = Path.resolve(seasonPath, folderImage.name);
    return {
      id: hash.mkFileId(path, this.library.name),
      name: folderImage.name,
      lastUpdated: new Date(),
      path: path,
      libraryName: this.library.name,
    };
  }

  static imageFileExtensions = [".png", ".jpg", ".jpeg"];

  separateSeasonFiles(seasonPath: string): Promise<SeasonFiles> {
    return fs
      .readdir(seasonPath, { withFileTypes: true })
      .then((dirEntries) => {
        const metadataFiles: MetadataFiles =
          this.getSeasonMetadataFiles(dirEntries);

        const remainingFiles = dirEntries.filter(
          (it) => it.isFile() && !Object.values(metadataFiles).includes(it)
        );

        return Promise.all(
          remainingFiles.map((it) => {
            const absPath = Path.resolve(seasonPath, it.name);
            return getInfo(absPath)
              .then((ffProbeInfo) => {
                return { dirent: it, ffProbeInfo: ffProbeInfo } as VideoFile;
              })
              .catch((err) => {
                log.error(
                  `Error scanning possible videoFile ${absPath}: ${err}`
                );
              });
          })
        ).then((files) => {
          const videoFiles = flow(
            filter(identity),
            filter<VideoFile>((it) => isVideo(it.ffProbeInfo))
          )(files);

          return this.extractEpisodeFileSet(
            metadataFiles,
            videoFiles,
            remainingFiles
          );
        });
      });
  }

  private extractEpisodeFileSet(
    metadataFiles: MetadataFiles,
    videoFiles: Awaited<VideoFile>[],
    remainingFiles: Dirent[]
  ) {
    return {
      metadataFiles: metadataFiles,
      dataFiles: {
        episodeFiles: videoFiles.map((videoFile) => {
          const videoParsePath = Path.parse(videoFile.dirent.name);
          const nfoFile = ShowScanner.getNfoFile(
            remainingFiles,
            videoParsePath
          );
          const subtitles = ShowScanner.getSubtitles(
            remainingFiles,
            videoParsePath
          );

          return {
            baseName: videoParsePath.name,
            video: videoFile,
            subtitles: subtitles,
            nfo: nfoFile,
          };
        }),
      },
    };
  }

  private getSeasonMetadataFiles(dirEntries: Dirent[]) {
    const folderImage = first(
      flow(
        filter<Dirent>((it) => it.isFile()),
        filter((it) => {
          const parsedPath = Path.parse(it.name);
          return (
            parsedPath.name.toLowerCase() == "folder" &&
            ShowScanner.imageFileExtensions.includes(
              parsedPath.ext.toLowerCase()
            )
          );
        })
      )(dirEntries)
    );

    return {
      folderImage: folderImage,
    };
  }

  private static getSubtitles(
    remainingFiles: Dirent[],
    videoParsePath: ParsedPath
  ) {
    return remainingFiles.filter((it) => {
      const parsedPath = Path.parse(it.name);
      return (
        parsedPath.name.startsWith(videoParsePath.name) &&
        parsedPath.ext.toLowerCase() == "srt"
      ); // TODO support other subtitles too
    });
  }

  private static getNfoFile(
    remainingFiles: Dirent[],
    videoParsePath: ParsedPath
  ) {
    return first(
      filter<Dirent>((it) => {
        const parsedPath = Path.parse(it.name);
        return (
          parsedPath.name == videoParsePath.name &&
          parsedPath.ext.toLowerCase() == ".nfo"
        );
      })(remainingFiles)
    );
  }
}
interface SeasonFiles {
  metadataFiles: MetadataFiles;
  dataFiles: DataFiles;
}

interface MetadataFiles {
  folderImage?: Dirent;
}
interface DataFiles {
  episodeFiles: EpisodeFileSet[];
}

interface EpisodeFileSet {
  baseName: string;
  video: VideoFile;
  subtitles: Dirent[];
  nfo?: Dirent;
}

interface VideoFile {
  dirent: Dirent;
  ffProbeInfo: FfProbeInfo;
}
