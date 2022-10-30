import Path from "path";
import { Scanner } from "./models";
import { Database, mkFileId } from "@rewind-media/rewind-common";
import klaw, { Item } from "klaw";
import { Library } from "@rewind-media/rewind-protocol";

export class FileScanner extends Scanner {
  constructor(library: Library, db: Database) {
    super(library, db);
  }

  scan(): Promise<number> {
    const start = new Date();
    return Promise.all(
      this.library.rootPaths.map(async (rootPath) => {
        const walker = klaw(rootPath);
        walker.on("data", async (item) => {
          walker.pause();
          await this.handleItem(item);
          walker.resume();
        });
        return await new Promise<null>((resolve, reject) => {
          walker.on("end", () => {
            resolve(null);
          });
        });
      })
    )
      .then(() => this.db.cleanShows(start, this.library.name))
      .then(() => 1);
  }

  private handleItem(item: Item): Promise<boolean> {
    return this.db.upsertFile({
      path: item.path,
      lastUpdated: new Date(),
      libraryName: this.library.name,
      name: Path.basename(item.path),
      id: mkFileId(item.path, this.library.name),
    });
  }
}
