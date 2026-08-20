# Deploying Loupe

Loupe is a static bundle. The container serves files and makes no outbound
request of its own: every SMART Health Link fetch is made by the browser that
has the page open. That single fact decides most of what follows, including why
this pod needs no egress and why running it at an event is a port-forward rather
than a hostname.

- `Dockerfile` builds the bundle with pnpm and serves it from
  `nginxinc/nginx-unprivileged`, non-root on port 8080.
- `nginx.conf` becomes `/etc/nginx/conf.d/default.conf`: SPA fallback, immutable
  caching for hashed assets, gzip, and the security header set (read the
  Content-Security-Policy comments before changing it).
- `k8s/` holds the two ArgoCD artefacts, ready to copy into `aehrc/sparked-argo`.

## Registry

| Fact | Value | Where it came from |
| --- | --- | --- |
| AWS account | `471112546300` | `aws sts get-caller-identity` |
| Region | `ap-southeast-2` | the image pinned in `sparked-argo` `apps/clinic-demo/values.yaml` |
| Registry host | `471112546300.dkr.ecr.ap-southeast-2.amazonaws.com` | same |
| Repository | `sparked/shl-loupe` | `aws ecr describe-repositories`: every workload repo is `sparked/<app>` |
| Cluster context | `sparkey` | `sparked-argo` `readme.md` |

`sparked/shl-loupe` does not exist yet. ECR never auto-creates a repository on
push, and Crossplane cannot make one here (`crossplane/providers.yaml` installs
the IAM, EKS, RDS and EC2 providers, no ECR provider), so this is a one-time CLI
call.

```sh
export AWS_REGION=ap-southeast-2
REG=471112546300.dkr.ecr.ap-southeast-2.amazonaws.com
REPO=sparked/shl-loupe

aws ecr create-repository \
  --repository-name "$REPO" \
  --region "$AWS_REGION" \
  --image-tag-mutability MUTABLE \
  --encryption-configuration encryptionType=AES256

# Optional, and kind to the bill: keep the last ten images.
aws ecr put-lifecycle-policy --region "$AWS_REGION" --repository-name "$REPO" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 10","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}'
```

Do not pass `--image-scanning-configuration`: the registry already has
`scanType: ENHANCED` with a `CONTINUOUS_SCAN` rule over a `*` filter, so Amazon
Inspector covers every repository. No image pull secret is needed either; the
node role carries ECR read, which is why neither `clinic-demo` nor
`platypus-site` sets one.

## Build and push

```sh
export AWS_REGION=ap-southeast-2
REG=471112546300.dkr.ecr.ap-southeast-2.amazonaws.com
REPO=sparked/shl-loupe
TAG=v0.1.0                 # bump per release; k8s/shl-loupe.values.yaml pins it

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REG"

# From the repo ROOT, not from deploy/.
docker buildx build \
  --platform linux/amd64 \
  --provenance=false --sbom=false \
  -f deploy/Dockerfile \
  -t "$REG/$REPO:$TAG" \
  --push .

# Confirm what actually landed. This guards the architecture trap below.
aws ecr batch-get-image --region "$AWS_REGION" --repository-name "$REPO" \
  --image-ids imageTag="$TAG" --query 'images[0].imageManifest' --output text | head -c 400
```

**`--platform linux/amd64` is mandatory.** Every non-tainted Karpenter NodePool
in the cluster pins `kubernetes.io/arch In ["amd64"]`; the only arm64 pool is
tainted, phase 0, and nothing opts into it. A plain `docker build` on an Apple
Silicon Mac produces arm64 only, and that lands as `exec format error` or
`ImagePullBackOff`.

`--provenance=false --sbom=false` stops buildx attaching attestation manifests.
Without them, `aws ecr describe-images` for a sibling repository shows a scatter
of untagged `unknown/unknown` manifests beside the real image, which is noise
somebody will misread in six months. `--push` rather than `--load` is required
whenever `--platform` is set: a multi-platform result cannot be loaded into the
local image store. The ECR login token lasts twelve hours.

Do not tag `:latest`. The values file is the deployment record, and it can only
be that if it names a specific tag.

To syntax-check the nginx configuration without deploying anything:

```sh
docker run --rm -v "$PWD/deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginxinc/nginx-unprivileged:1.30-alpine-slim nginx -t
```

## The ArgoCD commit

Two files go into `aehrc/sparked-argo`, plus two one-line edits. Copy them
rather than hand-retyping, so the reviewed content is what lands:

```sh
LOUPE=/path/to/shl-loupe
ARGO=/path/to/sparked-argo
cd "$ARGO"
git switch -c feat/shl-loupe

mkdir -p apps/shl-loupe
cp "$LOUPE/deploy/k8s/shl-loupe.application.yaml" apps/shl-loupe.yaml
cp "$LOUPE/deploy/k8s/shl-loupe.values.yaml"      apps/shl-loupe/values.yaml
```

Then, by hand:

1. `projects/proj-sparked.yaml`: add the destination, immediately before the
   `clusterResourceWhitelist:` line. ArgoCD refuses to deploy into a namespace
   its `AppProject` does not list, and fails at spec validation rather than at
   sync, so the symptom is a Sync status of Unknown with no rendered manifests.

   ```yaml
       - namespace: shl-loupe
         server: https://kubernetes.default.svc
         name: in-cluster
   ```

   `sourceRepos` needs no change: both sources are
   `https://github.com/aehrc/sparked-argo`, already listed.

2. `readme.md`: one line in the directory-structure block, beside its
   neighbours, so the listing does not go stale.

   ```
   │   ├── shl-loupe.yaml                 # Loupe: SMART Health Link viewer/debugger (port-forward only)
   ```

Verify before pushing. Expect exactly two documents, a Deployment and a Service.
An HTTPRoute in the output means `httpRoute.enabled` is wrong:

```sh
helm template shl-loupe charts/sparked-app -f apps/shl-loupe/values.yaml | grep '^kind:'
```

Then open the PR, and ArgoCD rolls it out on merge (`prune: true`,
`selfHeal: true`).

Three things not to add. No listener, `Certificate` or external-dns record in
`apps/common/networking/gateway-infra.yaml`: there is no hostname. No
NetworkPolicy file in either `network-policies/` directory: the pod needs no
egress at all, for the reasons set out in `k8s/shl-loupe.values.yaml`. No
`externalSecret`, `secretStore` or `crossplane` block: this app has no secrets by
design, because everything sensitive it touches lives in the viewer's browser tab
for the length of one session.

## Running it at an event

```sh
kubectl --context sparkey -n shl-loupe port-forward svc/shl-loupe 8080:80
```

Then open **http://localhost:8080**.

`--context sparkey` is not optional: `sparked-smile` is a different cluster, and
`kubectl config use-context` on the full ARN silently fails and leaves you on
whatever context was already active. `svc/shl-loupe` rather than a pod name is
also deliberate: kubectl resolves the Service's port 80 to a ready pod's 8080, so
the command survives a redeploy that changes the pod name.

port-forward dies when the pod restarts and has no retry flag, so for a demo:

```sh
while :; do kubectl --context sparkey -n shl-loupe port-forward svc/shl-loupe 8080:80; sleep 1; done
```

### `http://localhost:8080` is a secure context. `http://<LAN-IP>:8080` is not.

This decides how the tool gets used in a room, so it is worth stating precisely.

W3C *Secure Contexts*, section 3.1 *Is origin potentially trustworthy?*, returns
"Potentially Trustworthy" when the host matches `127.0.0.0/8` or `::1/128`, and
again when the host is `localhost` (or ends in `.localhost`) on a user agent that
follows the localhost name-resolution rules. The section closes with a note that
settles the obvious worry:

> Neither origin's domain nor port has any effect on whether or not it is
> considered to be a secure context.

So on a port-forward:

- **WebCrypto works.** The Web Cryptography API declares
  `[SecureContext] readonly attribute SubtleCrypto subtle`, which is why
  `crypto.subtle` is `undefined` outside a secure context rather than throwing.
  Loupe needs it for the `A256GCM` JWE decrypt and the `ES256` health-card
  verify, so this is load bearing.
- **QR scanning works**, same reason, given the `Permissions-Policy` in
  `nginx.conf` allows `camera=(self)`.

`kubectl port-forward --address 0.0.0.0` will happily bind every interface so a
colleague can reach `http://192.168.1.42:8080`. **Do not do that at an event.**
`192.168.1.42` is neither in `127.0.0.0/8` nor `localhost`, so section 3.1 falls
through to "Not Trustworthy": on their laptop `crypto.subtle` is `undefined`,
`navigator.mediaDevices` is `undefined`, and a debugger that cannot decrypt or
scan looks like a broken debugger rather than a browser rule.

Four ways to share, best first:

1. **They run their own port-forward.** Same command, their context, their
   `http://localhost:8080`. Secure on both machines. Needs cluster access.
2. **`ssh -L 8080:localhost:8080 you@your-laptop` from their machine**, while
   your port-forward runs. The page is `localhost` on their machine, so the
   secure context is preserved, and it needs no cluster credentials. This is the
   answer when somebody at the next seat wants to poke at it.
3. **Give it a real hostname.** Flip `httpRoute.enabled: true` with a hostname,
   add the listener and `Certificate` to `gateway-infra.yaml`, and cert-manager
   issues the certificate. HTTPS with no caveats, and about fifteen lines. This
   is the only real answer if it needs to be shared broadly.
4. **Last resort, their browser, their risk.** Chrome's
   `--unsafely-treat-insecure-origin-as-secure` (spec section 3.1's "configured
   as a trustworthy origin" step). Never offer this first: it teaches exactly the
   wrong lesson at an interoperability event.

One useful corollary. Section 3.1 also makes `file:` potentially trustworthy, and
Chrome and Firefox both implement that, so `pnpm build` and a zipped `dist/` is a
credible "here, run it yourself" handout. It works only while `base: './'` stays
and there are no path routes, which is another reason the router keeps everything
in the fragment.

### When someone says decryption is broken

Ask which URL they opened, before anyone opens devtools. The answer is already
in the run: `viewerOriginFromLocation` records the viewer's own protocol, host,
port and `isSecureContext`, and hands them to every static rule, so a trace taken
on a LAN IP says so itself. It is usually a one-line conversation: a LAN IP, not a
broken browser.
