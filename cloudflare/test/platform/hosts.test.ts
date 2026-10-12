// Domain names, IP addresses and web addresses (test/fixtures/hosts-tests.ts) in workerd, whose URL parser
// (`node:url` under nodejs_compat for IDNA) and Unicode data production uses; test/unit/hosts.test.ts runs the
// same tests in Node.

import { hostTests } from "../fixtures/hosts-tests.ts";

hostTests();
