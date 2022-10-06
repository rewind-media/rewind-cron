import {Database} from "@rewind-media/rewind-common";
import { Library } from "@rewind-media/rewind-protocol";

export abstract class Scanner {
  protected library: Library;
  protected db: Database;
  protected constructor(library: Library, db: Database) {
    this.library = library;
    this.db = db;
  }

  abstract scan(): Promise<number>;
}
