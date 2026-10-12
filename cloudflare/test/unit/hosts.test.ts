// Domain names, IP addresses and web addresses (test/fixtures/hosts-tests.ts) in Node, where the unit layer
// runs; test/platform/hosts.test.ts runs the same tests in workerd.

import { hostTests } from "../fixtures/hosts-tests.ts";

hostTests();
