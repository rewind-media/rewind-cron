import fs from "fs/promises";
import Path, { ParsedPath } from "path";
import { FfProbeInfo, getInfo } from "../util/ffprobe";
import { Scanner } from "./models";
import { FFProbeStream } from "ffprobe";
import { Dirent } from "fs";
import { Database, hash } from "@rewind-media/rewind-common";
import { CronLogger } from "../log";
import { Library, ShowSeasonInfo } from "@rewind-media/rewind-protocol";
import {
  any,
  filter,
  first,
  flow,
  identity,
  map,
  max,
  sum,
  negate,
} from "lodash/fp";
import { filterNotNil, mapSeries } from "cantaloupe";

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
    return mapSeries((rootPath: string) => {
      log.info(`Scanning ${rootPath}`);
      return fs
        .readdir(rootPath, { withFileTypes: true })
        .then(filter((dirEntry) => dirEntry.isDirectory()))
        .then((dirEntries) =>
          mapSeries((dirEntry: Dirent) =>
            this.scanShow(dirEntry.name, rootPath)
          )(dirEntries)
        )
        .then(sum);
    })(this.library.rootPaths)
      .then(sum)
      .then((upsertedRows) =>
        Promise.all([
          this.db.cleanShowEpisodes(start, this.library.name),
          this.db.cleanShowSeasons(start, this.library.name),
          this.db.cleanShows(start, this.library.name),
          this.db.cleanImages(start, this.library.name), // image file resources (season images, etc)
        ]).then(() => upsertedRows)
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
    log.info(`Scanning ${path} - show: ${showId}`);

    return fs
      .readdir(path, { withFileTypes: true })
      .then(filter((dirEntry) => dirEntry.isDirectory()))
      .then((dirEntries) =>
        mapSeries((dirEntry: Dirent) =>
          this.scanSeason(showId, Path.resolve(path, dirEntry.name))
        )(dirEntries)
          .then(sum)
          .then(async (count) => {
            if (count > 0) {
              await this.db.upsertShow({
                id: showId,
                showName: showName,
                libraryName: this.library.name,
                lastUpdated: new Date(),
              });
              return count;
            } else {
              return count;
            }
          })
          .catch((reason) => {
            log.error(
              `Error scanning show in ${this.library.name}: ${rootPath}/${showName}: ${reason}`
            );
            return 0;
          })
      );
  }

  private scanSeason(showId: string, seasonPath: string): Promise<number> {
    const seasonId = hash.mkFileId(seasonPath, this.library.name);
    log.info(`Scanning ${seasonPath} - season: ${seasonId}`);
    return this.separateSeasonFiles(seasonPath).then(
      ({ metadataFiles, dataFiles }) =>
        this.scanDataFiles(dataFiles, showId, seasonId, seasonPath)
          .then(sum)
          .then(async (count) => {
            if (count > 0) {
              await this.persistSeasonMetadata(
                showId,
                seasonPath,
                seasonId,
                metadataFiles
              ).catch((e) =>
                log.error(`Error persisting season metadata ${e}`)
              );
            }
            return count;
          })
    );
  }

  private scanDataFiles(
    dataFiles: DataFiles,
    showId: string,
    seasonId: string,
    seasonPath: string
  ) {
    return mapSeries((episodeFileSet: EpisodeFileSet) => {
      return this.db
        .upsertShowEpisode({
          id: episodeFileSet.video.id,
          name: episodeFileSet.baseName,
          showId: showId,
          seasonId: seasonId,
          lastUpdated: new Date(),
          path: Path.resolve(seasonPath, episodeFileSet.video.dirent.name),
          libraryName: this.library.name,
          info: episodeFileSet.video.ffProbeInfo,
        })
        .then((res) => (res ? 1 : 0));
    })(dataFiles.episodeFiles);
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
      const showSeasonInfo: ShowSeasonInfo = {
        showId: showId,
        seasonName: seasonName,
        libraryName: this.library.name,
        id: hash.mkFileId(seasonPath, this.library.name),
        folderImageId: folderImageInfo?.id,
        lastUpdated: new Date(),
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

        return flow(
          filter(
            negate((it: Dirent) => {
              const parsedPath = Path.parse(it.name);
              return (
                ShowScanner.isNfoFile(parsedPath) ||
                ShowScanner.isSubtitlesFile(parsedPath) ||
                ShowScanner.isImageFile(parsedPath)
              );
            })
          ),
          mapSeries(async (it: Dirent) => {
            const absPath = Path.resolve(seasonPath, it.name);
            const id = hash.mkFileId(absPath, this.library.name);
            const lastModified = await fs
              .stat(absPath)
              .then(
                (stat) =>
                  new Date(
                    Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs)
                  )
              );
            log.debug(`${absPath} was last modified ${lastModified}`);

            return this.db.getShowEpisode(id).then((episodeInfo) =>
              episodeInfo && episodeInfo.lastUpdated > lastModified
                ? Promise.resolve(mkVideoFile(id, it, episodeInfo.info, false))
                : getInfo(absPath)
                    .then((ffProbeInfo) =>
                      mkVideoFile(id, it, ffProbeInfo, true)
                    )
                    .catch((err) => {
                      log.error(
                        `Error scanning possible video file at ${absPath}: ${err}`
                      );
                      return null;
                    })
            );
          })
        )(remainingFiles)
          .then(filterNotNil)
          .then((files: VideoFile[]) => {
            const videoFiles = flow(
              filter(identity), // TODO filterNotVoid
              filter<VideoFile>((it) => isVideo(it.ffProbeInfo))
            )(files);

            return this.extractSeasonFiles(
              metadataFiles,
              videoFiles,
              remainingFiles
            );
          });
      });
  }

  private extractSeasonFiles(
    metadataFiles: MetadataFiles,
    videoFiles: Awaited<VideoFile>[],
    remainingFiles: Dirent[]
  ): SeasonFiles {
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
        ShowScanner.isSubtitlesFile(parsedPath)
      ); // TODO support other subtitles too
    });
  }

  private static isSubtitlesFile(parsedPath: ParsedPath) {
    return parsedPath.ext.toLowerCase() == ".srt"; // TODO support other subtitles too
  }

  private static isNfoFile(parsedPath: ParsedPath) {
    return parsedPath.ext.toLowerCase() == ".nfo";
  }

  private static isImageFile(parsedPath: ParsedPath) {
    const ext = parsedPath.ext.toLowerCase();
    return ext == ".jpg" || ext == ".jpeg" || ext == ".png";
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
          ShowScanner.isNfoFile(parsedPath)
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
  id: string;
  dirent: Dirent;
  ffProbeInfo: FfProbeInfo;
  changed: boolean;
}

function mkVideoFile(
  id: string,
  dirent: Dirent,
  ffProbeInfo: FfProbeInfo,
  changed: boolean
): VideoFile {
  return { id: id, dirent: dirent, ffProbeInfo: ffProbeInfo, changed: changed };
}
