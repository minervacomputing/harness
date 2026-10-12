// Python 3.14's text rules on the runtime's Unicode (test/fixtures/unicode-tests.ts) in workerd, whose Unicode
// data production uses; test/unit/unicode.test.ts runs the same tests in Node.

import { unicodeTests } from "../fixtures/unicode-tests.ts";

unicodeTests();
