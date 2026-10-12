// OneDrive's zip reader on Office files in workerd, where production inflates through the runtime's
// DecompressionStream and zip.js checks each CRC-32 through its gzip form; test/unit/onedrive-zip.test.ts runs the same
// tests in Node.

import { zipTests } from "../fixtures/onedrive-zip-tests.ts";

zipTests();
