// The Office reader's zip reader on Office files in workerd, where production inflates through the runtime's
// DecompressionStream and zip.js checks each CRC-32 through its gzip form; test/unit/office-zip.test.ts runs the same
// tests in Node.

import { zipTests } from "../fixtures/office-zip-tests.ts";

zipTests();
