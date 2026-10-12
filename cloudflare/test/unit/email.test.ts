// Charsets, header injection, recipient checks, multipart selection and size limits of the Gmail connector's
// mail code (test/fixtures/email-tests.ts) in Node, where the unit layer runs; test/platform/email.test.ts
// runs the same tests in workerd.

import { emailTests } from "../fixtures/email-tests.ts";

emailTests();
