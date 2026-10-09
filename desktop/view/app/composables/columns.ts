import { type Column, columnOf } from "../../../src/shared/columns";

// Centred and capped inside the page's gutter. Wide fits a 120-column log line.
const CLASSES: Record<Column, string> = {
  reading: "mx-auto w-full min-w-0 max-w-3xl",
  wide: "mx-auto w-full min-w-0 max-w-5xl",
  full: "w-full min-w-0",
};

/** The classes that lay out a record's tab, or a page, in its column. */
export const columnClass = (tabOrPage: string) => CLASSES[columnOf(tabOrPage)];

/** The reading column, which every page's header, banner and tabs share. */
export const readingClass = CLASSES.reading;
