import { CronJob } from "cron";
import { FileScanner } from "./scanner/FileScanner";
import { ShowScanner } from "./scanner/ShowScanner";
import { CronLogger as log } from "./log";
import { Library, LibraryType } from "@rewind-media/rewind-protocol";
import { Database } from "@rewind-media/rewind-common";
import { flow, map } from "lodash/fp";
import { filterNotNil, mapSeries } from "cantaloupe";

export function runCron(db: Database) {
  return new CronJob(
    "* * * 2 * *",
    () =>
      db.listLibraries().then((libraries) =>
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
          filterNotNil,
          mapSeries((scanner) => scanner.scan())
        )(libraries)
      ),
    null,
    true,
    undefined,
    null,
    true
  );
}
