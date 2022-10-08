import fs from "fs/promises";
import Path, { ParsedPath } from "path";
import { FfProbeInfo, getInfo } from "../util/ffprobe";
import { Scanner } from "./models";
import { FFProbeStream } from "ffprobe";
import { Dirent } from "fs";
import { Database, hash } from "@rewind-media/rewind-common";
import { CronLogger } from "../log";
import {
  ImageInfo,
  Library,
  ShowSeasonInfo,
} from "@rewind-media/rewind-protocol";
import {
  any,
  filter,
  first,
  flow,
  identity,
  map,
  max,
  negate,
  sum,
} from "lodash/fp";
import { emptyPromise, filterNotNil, mapSeries } from "cantaloupe";
import { mkFileId } from "@rewind-media/rewind-common/dist/util/hash";
import { isNotNil } from "cantaloupe/dist/functions";

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
      .then(async (dirEntries) => {
        const dirs = dirEntries.filter((dirEntry) => dirEntry.isDirectory());
        const count = await mapSeries((dir: Dirent) =>
          this.scanSeason(showId, Path.resolve(path, dir.name))
        )(dirs)
          .then(sum)
          .catch((reason) => {
            log.error(
              `Error scanning show in ${this.library.name}: ${rootPath}/${showName}: ${reason}`
            );
            return 0;
          });
        if (count > 0) {
          const seriesImageInfo = this.extractImageInfo(
            dirEntries,
            path,
            "folder"
          );

          const bannerImageInfo = first(
            flow(
              map((name: string) =>
                this.extractImageInfo(dirEntries, path, name)
              ),
              filterNotNil
            )(["backdrop", "banner"])
          );

          await mapSeries((it: ImageInfo) => this.db.upsertImage(it))(
            filterNotNil([bannerImageInfo, seriesImageInfo])
          );

          await this.db.upsertShow({
            id: showId,
            showName: showName,
            libraryName: this.library.name,
            lastUpdated: new Date(),
            seriesImageId: seriesImageInfo?.id,
            seriesBackdropImageId: bannerImageInfo?.id,
          });
          return count;
        } else {
          return count;
        }
      });
  }

  private extractImageInfo(
    dirEntries: Dirent[],
    path: string,
    imageName: string
  ): ImageInfo | undefined {
    const seriesImage = dirEntries
      .filter((it) => it.isFile())
      .find((ent) => {
        const parsed = Path.parse(ent.name);
        return (
          parsed.name == imageName &&
          ShowScanner.imageFileExtensions.includes(parsed.ext)
        );
      });
    const seriesImagePath = seriesImage
      ? Path.resolve(path, seriesImage.name)
      : undefined;
    const seriesImageInfo =
      seriesImage && seriesImagePath
        ? {
            name: seriesImage.name,
            id: mkFileId(seriesImagePath, this.library.name),
            path: seriesImagePath,
            libraryName: this.library.name,
            lastUpdated: new Date(),
          }
        : undefined;
    return seriesImageInfo;
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
    return mapSeries(async (episodeFileSet: EpisodeFileSet) => {
      if (episodeFileSet.image) {
        await this.db.upsertImage(episodeFileSet.image);
      }
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
          episodeImageId: episodeFileSet.image?.id,
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

    return mapSeries((it: ImageInfo) => this.db.upsertImage(it))(
      filterNotNil([metadataFiles.folderImage])
    ).then(() => {
      const showSeasonInfo: ShowSeasonInfo = {
        showId: showId,
        seasonName: seasonName,
        libraryName: this.library.name,
        id: hash.mkFileId(seasonPath, this.library.name),
        folderImageId: metadataFiles.folderImage?.id,
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

  separateSeasonFiles(seasonPath: string): Promise<SeasonFiles> {
    return fs
      .readdir(seasonPath, { withFileTypes: true })
      .then(async (dirEntries) => {
        const metadataFiles: MetadataFiles = await this.getSeasonMetadataFiles(
          dirEntries,
          seasonPath
        );

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

          const image = metadataFiles.metadataFolder
            ? this.extractImageInfo(
                metadataFiles.metadataFolder.entries,
                metadataFiles.metadataFolder.path,
                videoParsePath.name
              )
            : undefined;

          return {
            baseName: videoParsePath.name,
            video: videoFile,
            subtitles: subtitles,
            nfo: nfoFile,
            image: image,
          };
        }),
      },
    };
  }

  private getSeasonMetadataFiles(
    dirEntries: Dirent[],
    seasonPath: string
  ): Promise<MetadataFiles> {
    return this.getSeasonMetadataFolder(dirEntries, seasonPath).then(
      (metadataFolder) => {
        return {
          folderImage: this.extractImageInfo(dirEntries, seasonPath, "folder"),
          metadataFolder: metadataFolder,
        };
      }
    );
  }

  private async getSeasonMetadataFolder(
    seasonFolderEntries: Dirent[],
    seasonPath: string
  ): Promise<MetadataFolder | undefined> {
    if (
      seasonFolderEntries.find(
        (it) => it.name == "metadata" && it.isDirectory()
      )
    ) {
      const path = Path.resolve(seasonPath, "metadata");
      return await fs
        .readdir(path, {
          withFileTypes: true,
        })
        .then((entries) => {
          return {
            entries: entries,
            path: path,
          };
        });
    } else {
      return emptyPromise();
    }
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

  static imageFileExtensions = [".png", ".jpg", ".jpeg"];

  private static isImageFile(parsedPath: ParsedPath) {
    const ext = parsedPath.ext.toLowerCase();
    return ShowScanner.imageFileExtensions.includes(ext);
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
  folderImage?: ImageInfo;
  metadataFolder?: MetadataFolder;
}

interface MetadataFolder {
  path: string;
  entries: Dirent[];
}
interface DataFiles {
  episodeFiles: EpisodeFileSet[];
}

interface EpisodeFileSet {
  baseName: string;
  video: VideoFile;
  subtitles: Dirent[];
  nfo?: Dirent;
  image?: ImageInfo;
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
