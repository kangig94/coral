import { runBackendMain } from '#src/coordinator/bootstrap.js';
import { successionInterpositionFromEnvironment } from '#tests/fixtures/succession-interposition.js';

runBackendMain({ successionInterposition: successionInterpositionFromEnvironment() });
