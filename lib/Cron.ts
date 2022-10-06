import { CronJob } from "cron";
import { FileScanner } from "./scanner/FileScanner";
import { ShowScanner } from "./scanner/ShowScanner";
import { CronLogger as log } from "./log";
import { Library, LibraryType } from "@rewind-media/rewind-protocol";
import { Database } from "@rewind-media/rewind-common";
import { filter, flow, identity, map } from "lodash/fp";
import { Scanner } from "./scanner/models";

export function runCron(db: Database) {
  return new CronJob(
    "* * * 2 * *",
    () =>
      db.listLibraries().then((libraries) =>
        Promise.all(
          flow(
            map((library: Library) => {
              switch (library.type) {
                case LibraryType.File:
                  return new FileScanner(library, db);
                case LibraryType.Show:
                  return new ShowScanner(library, db);
                default:
                  log.warn(
                    `Unknown LibraryType '${library.type}' when scanning ${library.name}`
                  );
                  return null;
              }
            }),
            filter<Scanner>(identity),
            map((scanner: Scanner) => scanner.scan())
          )(libraries)
        )
      ),
    null,
    true,
    undefined,
    null,
    true
  );
}
