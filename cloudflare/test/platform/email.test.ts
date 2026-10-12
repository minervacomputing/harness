// Charsets, header injection, recipient checks, multipart selection and size limits of the Gmail connector's
// mail code (test/fixtures/email-tests.ts) in workerd, whose TextDecoder and encodings production uses;
// test/unit/email.test.ts runs the same tests in Node.

import { emailTests } from "../fixtures/email-tests.ts";

emailTests();
