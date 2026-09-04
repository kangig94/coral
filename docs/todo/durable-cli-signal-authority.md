# TODO — finish durable-CLI signal authority and refusal status

**Status**: identity-safe containment is implemented; durable refusal status remains deliberately deferred
from the starvation-survival branch.

Starvation does not kill the coordinator. A crash can therefore lose the current refusal's visibility or
strand artifacts, but it must not lose authority over live work. Recovery remains unable to act without its
own observation, while the recorded process containment remains evidence rather than signal authority by
itself.

## Subject after durable CLI v2

The durable subject is no longer the wrapper pid alone. It contains:

- the detached wrapper leader's {pid, incarnation};
- the process-group id established by that leader;
- the provider command's root {pid, incarnation}.

Absence requires the process group and the recorded child root to be absent. A wrapper death alone decides
nothing about the provider command. The version-addressed durable_cli_process.v2 key makes this payload
invisible to an older v1 selector; readers decode missing, corrupt, or foreign bytes to no usable identity and
refuse conservatively.

## Decided status design

The durable row for a refused signal is job-scoped and belongs on the jobs domain's existing stream. It is not
a provider-proxy record and not an entry in a cross-domain hold store.

Key the current status by the job and exact v2 subject. Record the refusal disposition and writer
{pid, incarnation}; the row is evidence, never authority. A reader from a different writer treats it as a
predecessor record, re-observes the full containment, and reaches its own disposition. No lease or epoch is
needed because bound-socket authority already serializes coordinators.

Retire the status when the reader itself confirms containment absence, when a supported operator action
abandons the obligation, or during terminal job cleanup. Existing backend status diagnostics and startup
recovery enumeration are the readers.

## Remaining implementation

- Persist each durable-transport signal refusal and its transition out of refusal on the jobs stream.
- Expose the refusal through existing backend status and startup recovery views.

Do not solve this with a unified jobs-and-proxy hold store. It would erase owner vocabulary, violate the
store/proxy layering boundary, and invite unrelated obligations into one content-blank abstraction.
