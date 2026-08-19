# Deploying `shl-loupe` into `aehrc/sparked-argo` (static Vite SPA, nginx, port-forward only)

Researched 2026-08-20 against `aehrc/sparked-argo` @ working tree, `aehrc/platypus` `deploy/`,
live AWS (`aws sts get-caller-identity` = account `471112546300`, admin SSO), the
`nginx/docker-nginx-unprivileged` sources, and the W3C/RFC specs cited inline.

Everything below is filled in and commit-ready. Four files change in `sparked-argo`, three
files are added to `shl-loupe`, one AWS call runs once.

---

## 0. Verdict, in one screen

| Question | Answer |
| --- | --- |
| Pattern | **Pattern 1: `charts/sparked-app` + `apps/shl-loupe/values.yaml`.** Not raw manifests. |
| Files in `sparked-argo` | `apps/shl-loupe.yaml` (new), `apps/shl-loupe/values.yaml` (new), `projects/proj-sparked.yaml` (one destination added), `readme.md` (one directory-listing line) |
| Generator | `scripts/new-app.sh --name shl-loupe --port 8080` (omit `--hostname` and it emits `httpRoute.enabled: false` and adds the namespace to the AppProject) |
| ECR repo | `471112546300.dkr.ecr.ap-southeast-2.amazonaws.com/sparked/shl-loupe` |
| Repo must be created first? | **Yes.** Verified: no `sparked/shl-loupe` exists today. ECR does not auto-create on push. Not Crossplane-able here (no `provider-aws-ecr` installed). One `aws ecr create-repository`. |
| Build platform | **`--platform linux/amd64` is mandatory.** Every non-tainted Karpenter NodePool pins `kubernetes.io/arch In ["amd64"]`. A plain `docker build` on an Apple Silicon Mac yields arm64 only, which lands as `exec format error`. |
| Base image | `nginxinc/nginx-unprivileged:1.30-alpine-slim`, listens 8080, `USER 101`, pid already redirected to `/tmp/nginx.pid` |
| `readOnlyRootFilesystem` | Yes, supported, with `emptyDir` on `/tmp` (+ `/var/cache/nginx` as belt-and-braces) |
| Egress NetworkPolicy risk | **None.** No policy file exists for a `shl-loupe` namespace, so the namespace is default-allow. And the pod needs zero egress: nginx serves files baked into the image, has no `proxy_pass`, no `resolver`, and the browser (not the pod) makes every SHL request. |
| Port-forward vs NetworkPolicy | port-forward works even under default-deny-ingress, because the kubelet proxies **inside the pod netns over loopback** (`nsenter -t $sandbox_pid -n socat - TCP4:localhost:8080`). The **readiness probe does not** and would need a node-CIDR allow if a phase-1 file is ever added. |
| `http://localhost:PORT` a secure context? | **Yes**, guaranteed by spec, and port is explicitly irrelevant. So WebCrypto and `getUserMedia` work. |
| `http://<LAN-IP>:PORT` a secure context? | **No.** This is the thing that breaks when you share a port-forward with a colleague. Fix listed in §5. |

---

## 1. Which pattern, and why

### Use Pattern 1 (the generic chart)

`charts/sparked-app` covers everything this app needs, and it covers it with values rather
than YAML you maintain. Checked against `charts/sparked-app/templates/deployment.yaml` and
`service.yaml` line by line:

| Requirement | Chart support |
| --- | --- |
| 1 replica | `deployment.replicas` (rendered only when `hpa.enabled` is false) |
| container port 8080 | `deployment.ports` (raw list, passed through `toYaml`) |
| pod `securityContext` (`runAsNonRoot`, `runAsUser`, `seccompProfile`) | `deployment.podSecurityContext` |
| container `securityContext` (`readOnlyRootFilesystem`, `drop: ALL`, `allowPrivilegeEscalation: false`) | `deployment.securityContext` |
| writable `emptyDir` for nginx `/tmp` | `deployment.volumes` + `deployment.volumeMounts` |
| tiny requests/limits | `deployment.resources` |
| probes | `deployment.livenessProbe` / `readinessProbe` |
| ClusterIP Service 80 → 8080 | `service.enabled` + `service.ports` |
| **no** HTTPRoute / hostname | `httpRoute.enabled: false` (the default; nothing is rendered, no gateway listener needed) |

### Do not copy `apps/platypus-site/`

`apps/platypus-site/platypus-workload.yaml` is hand-written Deployment + Service + HTTPRoute,
and `apps/platypus-site.yaml` (the `Application` that would sync it) is **entirely commented
out** with `# Disabled for now`. It is the older, pre-chart shape. `apps/checkin-wellknown/` is
the same shape. `apps/clinic-demo/values.yaml` is the current, live, chart-based example, and it
is the one to mirror: same image-from-Platypus-repo story, same `nginx`/node-on-8080 story, same
`runAsNonRoot` + `readOnlyRootFilesystem` posture.

`charts/sparked-app/README.md` states the intent directly: *"a toolbox of toggleable,
independently-enabled sections ... so an app declares only what it needs in one `values.yaml`
instead of hand-writing raw manifests."*

### Generate it, do not hand-write it

```bash
cd /Users/pet260/Documents/repos/sparked-argo
scripts/new-app.sh --name shl-loupe --port 8080 --dry-run   # inspect
scripts/new-app.sh --name shl-loupe --port 8080             # write
```

Omitting `--hostname` is a first-class path in the script: `http_route_block()` emits

```yaml
# httpRoute disabled (no --hostname given). Enable and add a listener to gateway-infra.yaml if needed.
httpRoute:
  enabled: false
```

and `add_project_namespace()` idempotently inserts the `shl-loupe` destination into
`projects/proj-sparked.yaml` before the `clusterResourceWhitelist:` line. Then replace the
generated `values.yaml` with the one below (the generated one has generic 100m/256Mi resources,
commented-out hardening, and an `externalSecret`/`crossplane` block this app does not want).

---

## 2. The files to commit

### 2a. `apps/shl-loupe.yaml`

The `Application`. Note it is **multi-source**: source 1 is the values repo (`ref: values`),
source 2 is the chart path, and the value file is addressed as `$values/...`. That is the shape
every Pattern-1 app uses (`apps/clinic-demo.yaml` is identical modulo names).

```yaml
# Loupe: a SMART Health Link viewer, debugger and teaching tool. A static Vite SPA
# served by nginx from an image built in aehrc/shl-loupe (deploy/Dockerfile).
#
# Deliberately has NO HTTPRoute and NO hostname: it is reached with
#   kubectl --context sparkey -n shl-loupe port-forward svc/shl-loupe 8080:80
# so nothing is added to apps/common/networking/gateway-infra.yaml. Add a
# listener + Certificate there, and flip httpRoute.enabled in the values, if it
# ever needs a public name.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shl-loupe
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: sparked
  destination:
    server: https://kubernetes.default.svc
    namespace: shl-loupe
  sources:
    - repoURL: https://github.com/aehrc/sparked-argo
      targetRevision: HEAD
      ref: values
    - repoURL: https://github.com/aehrc/sparked-argo
      targetRevision: HEAD
      path: charts/sparked-app
      helm:
        releaseName: shl-loupe
        valueFiles:
          - '$values/apps/shl-loupe/values.yaml'
  syncPolicy:
    # The pod satisfies every `restricted` control (runAsNonRoot + numeric uid,
    # seccompProfile RuntimeDefault, drop ALL, allowPrivilegeEscalation false,
    # emptyDir/configMap volumes only), so this namespace can carry warn+audit
    # from day one rather than inheriting the deferred position in
    # docs/pod-security-hardening.md.
    managedNamespaceMetadata:
      labels:
        pod-security.kubernetes.io/warn: restricted
        pod-security.kubernetes.io/audit: restricted
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - RespectIgnoreDifferences=true
      - SkipDryRunOnMissingResource=true
    retry:
      limit: 3
      backoff:
        duration: 10s
        maxDuration: 2m
        factor: 2
```

Dropped from the scaffolder template on purpose: the `ignoreDifferences` block for
`shl-loupe-secrets`. There is no `ExternalSecret` here, so there is no Secret whose `/data`
drifts, and an `ignoreDifferences` entry naming a resource that never exists is noise.

> **Why the values file lives in a subdirectory.** `project-apps.yml`'s `sparked-project-apps`
> syncs `path: 'apps/'` with `directory.include: '*'` and **no** `recurse`, so it renders only
> the `*.yaml` files sitting directly in `apps/`. A `values.yaml` placed directly in `apps/`
> would be handed to ArgoCD as a manifest and fail; inside `apps/shl-loupe/` it is invisible to
> that Application and is read only through the `$values` ref above.

### 2b. `apps/shl-loupe/values.yaml`

```yaml
# Values for the shared sparked-app chart (charts/sparked-app).
#
# Loupe: a SMART Health Link viewer/debugger. Entirely client-side: the BROWSER
# makes every SHL manifest and file request, this pod only serves the bundle. It
# therefore originates no outbound traffic at all (no proxy_pass, no resolver).
#
# No HTTPRoute: reached by `kubectl port-forward` only (see the readme note in
# apps/shl-loupe.yaml).
deployment:
  enabled: true
  replicas: 1
  image:
    # Built and pushed manually from aehrc/shl-loupe (deploy/README.md); there is
    # no image-build CI. Bump this tag per release, since Renovate does NOT track it
    # (its argocd manager only follows `targetRevision`, never an image tag
    # inside a values file; see renovate.json).
    repository: 471112546300.dkr.ecr.ap-southeast-2.amazonaws.com/sparked/shl-loupe
    tag: "v0.1.0"
    pullPolicy: IfNotPresent
  ports:
    - name: http
      containerPort: 8080
  readinessProbe:
    httpGet:
      path: /healthz
      port: 8080
    initialDelaySeconds: 2
    periodSeconds: 10
  livenessProbe:
    httpGet:
      path: /healthz
      port: 8080
    initialDelaySeconds: 5
    periodSeconds: 30
  resources:
    requests:
      cpu: 10m
      memory: 16Mi
    # Memory limit only, deliberately. A CPU limit on an nginx serving a handful
    # of static files buys nothing and adds cfs throttling on the burst that
    # matters (the first page load).
    limits:
      memory: 64Mi
  podSecurityContext:
    # nginxinc/nginx-unprivileged runs as uid/gid 101 (ARG UID=101 / GID=101 →
    # `USER $UID` in stable/alpine-slim/Dockerfile). State it numerically: the
    # kubelet cannot verify runAsNonRoot against a non-numeric image USER and
    # fails the pod at admission instead (same note as apps/clinic-demo).
    runAsNonRoot: true
    runAsUser: 101
    runAsGroup: 101
    seccompProfile:
      type: RuntimeDefault
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: ["ALL"]
  volumeMounts:
    # Required by readOnlyRootFilesystem. The unprivileged image already rewrites
    # nginx.conf so the pid file and all *_temp_path targets live under /tmp
    # (see stable/alpine-slim/Dockerfile lines 119-120), so /tmp is the only
    # genuinely-needed writable path; /var/cache/nginx is belt-and-braces for a
    # future config that turns on a cache.
    - name: tmp
      mountPath: /tmp
    - name: nginx-cache
      mountPath: /var/cache/nginx
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 16Mi
    - name: nginx-cache
      emptyDir:
        sizeLimit: 16Mi

service:
  enabled: true
  type: ClusterIP
  ports:
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP

# No public name, no gateway listener, no certificate. `kubectl port-forward`
# only. If this ever needs a hostname: flip enabled, add hostnames + rules
# (see charts/sparked-app/README.md), and add a listener + Certificate to
# apps/common/networking/gateway-infra.yaml in the same change.
httpRoute:
  enabled: false
```

No `capabilities.add: ["NET_BIND_SERVICE"]` is needed, and that is the whole point of the
unprivileged image: 8080 is unprivileged, unlike the inferno nginx sidecar on port 80 that
`drop: ["ALL"]` breaks (`docs/pod-security-hardening.md`).

### 2c. `projects/proj-sparked.yaml`

ArgoCD refuses to deploy into a namespace the `AppProject` does not list. Insert immediately
before `clusterResourceWhitelist:` (this is exactly what `new-app.sh` does):

```yaml
    - namespace: shl-loupe
      server: https://kubernetes.default.svc
      name: in-cluster
```

`sourceRepos` needs no change: both sources are `https://github.com/aehrc/sparked-argo`, already
listed. The `471112546300.dkr.ecr.ap-southeast-2.amazonaws.com/sparked` entry there is for OCI
**Helm charts** ArgoCD pulls, not for workload images.

### 2d. `readme.md`

One line in the directory-structure block, beside its neighbours, so the listing does not go
stale:

```
│   ├── shl-loupe.yaml                 # Loupe: SMART Health Link viewer/debugger (port-forward only)
```

### Sanity-check before pushing

```bash
cd /Users/pet260/Documents/repos/sparked-argo
helm template shl-loupe charts/sparked-app -f apps/shl-loupe/values.yaml
```

Expect exactly two documents (Deployment, Service) and nothing else. If an HTTPRoute appears,
`httpRoute.enabled` is wrong.

---

## 3. ECR: repository, creation, build and push

### Facts, verified live on 2026-08-20

- Account `471112546300`, region `ap-southeast-2`, registry host
  `471112546300.dkr.ecr.ap-southeast-2.amazonaws.com`.
- Naming convention is `sparked/<app>`: `aws ecr describe-repositories` returns
  `sparked/platypus-site`, `sparked/checkin-verifier`, `sparked/distil`, `sparked/smile`,
  `sparked/ontoserver`, `sparked/runner*`, `sparked/fhir-ig-feeder`, plus `logimomo/api`,
  `logimomo/ui`, `sparked-test-data-loader`. So: **`sparked/shl-loupe`**.
- **It does not exist yet.** ECR never auto-creates on push; the push fails with
  `name unknown: The repository with name 'sparked/shl-loupe' does not exist in the registry`.
- Existing `sparked/*` repos are `imageTagMutability: MUTABLE`, `encryptionType: AES256`, no
  lifecycle policy.
- Per-repo `scanOnPush` is irrelevant here: `aws ecr get-registry-scanning-configuration`
  returns `scanType: ENHANCED` with a `CONTINUOUS_SCAN` rule and a `*` wildcard filter, so
  Amazon Inspector already covers every repository in the registry. Do not pass
  `--image-scanning-configuration`.
- **Crossplane cannot create it.** `crossplane/providers.yaml` installs only
  `provider-aws-iam`, `provider-aws-eks`, `provider-aws-rds`, `provider-aws-ec2`, with no
  `provider-aws-ecr`. And the IAM permissions boundary
  (`arn:aws:iam::471112546300:policy/crossplane-managed-role-boundary`) is documented in
  `charts/sparked-app/values.yaml` as covering "Secrets Manager read, KMS decrypt, EC2 describe
  and **ECR read**". So repository creation is an out-of-band `aws` CLI call, exactly as
  `aehrc/platypus` `deploy/site/README.md` already prescribes. Console works too; CLI is
  reproducible.
- **No image pull secret is needed.** Neither `apps/clinic-demo/values.yaml` nor
  `apps/platypus-site/platypus-workload.yaml` sets `imagePullSecrets`; the node IAM role carries
  ECR read. (The `ECRAuthorizationToken` generator in `apps/common/secrets/ecr-generator.yaml`
  lives in the `argocd` namespace and exists so ArgoCD can pull OCI Helm charts, nothing to do
  with workload pulls.)

### The architecture trap, stated plainly

Every live NodePool pins amd64:

```
apps/karpenter-config/nodepool-ondemand-prod.yaml:56   kubernetes.io/arch In ["amd64"]
apps/karpenter-config/nodepool-ondemand-overflow.yaml:43  kubernetes.io/arch In ["amd64"]
apps/karpenter-config/nodepool-ci.yaml:84              kubernetes.io/arch In ["amd64"]
apps/karpenter-config/nodepool-spot-arm64.yaml:33      kubernetes.io/arch In ["arm64"]   # PHASE 0, tainted, nothing opts in
```

`docs/arm64-rollout.md` is explicit that the arm64 pool is tainted opt-in and that the failure
mode for an image with no matching variant is *"`exec format error` or `ImagePullBackOff`,
cluster-wide"*. A plain `docker build` on an M-series Mac produces `linux/arm64` only. Pass
`--platform linux/amd64` every time.

(For reference, `sparked/platypus-site:v0.1.0` is an
`application/vnd.oci.image.index.v1+json` carrying both amd64 and arm64, so someone did use
buildx there. Single-arch amd64 is the right choice for this app: half the build time, and
arm64 is unreachable today anyway.)

### The commands

```bash
# From the shl-loupe repo root.
export AWS_REGION=ap-southeast-2
ACCOUNT=471112546300
REG="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
REPO=sparked/shl-loupe
TAG=v0.1.0                 # bump per release; apps/shl-loupe/values.yaml pins it

# --- one time only ---
aws ecr create-repository \
  --repository-name "$REPO" \
  --region "$AWS_REGION" \
  --image-tag-mutability MUTABLE \
  --encryption-configuration encryptionType=AES256

# Optional but kind to the bill: keep the last 10 tagged images.
aws ecr put-lifecycle-policy --region "$AWS_REGION" --repository-name "$REPO" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 10","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}'

# --- every release ---
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REG"

docker buildx build \
  --platform linux/amd64 \
  --provenance=false --sbom=false \
  -f deploy/Dockerfile \
  -t "$REG/$REPO:$TAG" \
  --push .

# Confirm what actually landed (guards the arch trap).
aws ecr batch-get-image --region "$AWS_REGION" --repository-name "$REPO" \
  --image-ids imageTag="$TAG" --query 'images[0].imageManifest' --output text \
  | head -c 400
```

Then set the same `$TAG` in `apps/shl-loupe/values.yaml`, open the PR, and ArgoCD rolls it.

Notes on the flags. `--provenance=false --sbom=false` stops buildx attaching attestation
manifests; without them `describe-images` for `sparked/platypus-site` shows a scatter of
untagged `unknown/unknown` manifests beside the real ones, which is noise you will read wrongly
in six months. `--push` (not `--load`) is required whenever `--platform` is set, because a
multi-platform result cannot be loaded into the local docker image store. The ECR login token is
valid for 12 hours.

---

## 4. The image: nginx for a Vite SPA, non-root on 8080

### What the base image already does for you

From `nginx/docker-nginx-unprivileged`, `stable/alpine-slim/Dockerfile` (fetched, lines quoted):

```dockerfile
RUN sed -i 's,listen       80;,listen       8080;,' /etc/nginx/conf.d/default.conf \
    && sed -i '/user  nginx;/d' /etc/nginx/nginx.conf \
    && sed -i 's,\(/var\)\{0,1\}/run/nginx.pid,/tmp/nginx.pid,' /etc/nginx/nginx.conf \
    && sed -i "/^http {/a \    proxy_temp_path /tmp/proxy_temp;\n    client_body_temp_path /tmp/client_temp;\n    fastcgi_temp_path /tmp/fastcgi_temp;\n    uwsgi_temp_path /tmp/uwsgi_temp;\n    scgi_temp_path /tmp/scgi_temp;\n" /etc/nginx/nginx.conf \
    ...
EXPOSE 8080
STOPSIGNAL SIGQUIT
USER $UID          # ARG UID=101
```

So: pid and temp paths already under `/tmp`, no `user` directive to fail on as non-root, uid 101.
`readOnlyRootFilesystem: true` needs nothing but an `emptyDir` on `/tmp`.

Two more verified points that stop a self-inflicted CrashLoop:

- The entrypoint script `10-listen-on-ipv6-by-default.sh` does
  `touch /$DEFAULT_CONF_FILE 2>/dev/null || { ... exit 0; }`, so it degrades gracefully on a
  read-only filesystem instead of failing the container. It also bails when the conf differs
  from the packaged one, which ours does.
- **`application/wasm` is in nginx's stock `conf/mime.types`** (line 55,
  `application/wasm  wasm;`). No `types { }` override is needed. This matters because
  `zxing-wasm` uses `WebAssembly.instantiateStreaming`, which rejects with
  *"Incorrect response MIME type. Expected 'application/wasm'"* if the file is served as
  `application/octet-stream`.

Use `-alpine-slim`, not `-alpine`: the slim variant carries the same base configure args
(`--with-http_gzip_static_module` is in `pkg-oss/alpine/Makefile` `BASE_CONFIGURE_ARGS`, line 83)
without njs, geoip, image-filter, `curl` or `ca-certificates`. The only cost is that
`kubectl exec … curl` is unavailable for in-pod probing, and you are using port-forward anyway.

### `deploy/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
#
# Loupe: a SMART Health Link viewer/debugger. A static Vite SPA served by nginx.
#
# Build from the repo ROOT:
#   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
#     -f deploy/Dockerfile -t <ecr>/sparked/shl-loupe:<tag> --push .
#
# linux/amd64 is not optional: every non-tainted Karpenter NodePool on the
# sparkey cluster pins kubernetes.io/arch=amd64.

ARG NODE_VERSION=24-alpine
ARG NGINX_VERSION=1.30-alpine-slim

# ---------- build ----------
FROM node:${NODE_VERSION} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src

# Lockfile-only layer, so a source-only edit does not reinstall.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Pre-compress for `gzip_static on`. Pure shell, no extra dependency: nginx will
# serve foo.js.gz when the client sends Accept-Encoding: gzip, and fall back to
# on-the-fly gzip otherwise. -k keeps the original (needed for clients that do
# not accept gzip and for Range requests).
RUN find dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
         -o -name '*.json' -o -name '*.map' -o -name '*.wasm' \) \
      -size +1k -exec gzip -9 -k -f {} +

# ---------- runtime ----------
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}
# The base image already listens on 8080, runs as uid 101, and has its pid file
# and every *_temp_path redirected to /tmp, so the runtime needs no root layer.
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/
EXPOSE 8080
```

### `deploy/nginx/default.conf`

```nginx
# nginx config for the Loupe SPA image. Lands at /etc/nginx/conf.d/default.conf,
# replacing the stock server block. conf.d is included from inside `http {}`, so
# an http-context directive such as `map` is legal here.

# ---------------------------------------------------------------------------
# Cache-Control as a variable, so that EVERY response header can be emitted from
# ONE add_header set at server level.
#
# This is not stylistic. nginx's add_header does not merge across levels: a
# nested location that declares any add_header of its own DISCARDS every
# add_header inherited from the server block. Setting Cache-Control inside
# `location /assets/` would therefore silently strip the entire CSP and security
# header set from exactly the files an attacker would want unprotected.
# ---------------------------------------------------------------------------
map $uri $loupe_cache_control {
    # index.html and anything else served through the SPA fallback: always
    # revalidate, so a redeploy is picked up on the next load rather than after
    # a hard refresh nobody thinks to do at an event.
    default        "no-cache";
    # Vite's hashed output. The filename changes whenever the bytes change, so
    # this is the one place `immutable` is honest.
    "~^/assets/"   "public, max-age=31536000, immutable";
}

# Access log without the query string. An SHL carries the payload decryption key
# ("key" in the shlink JWS). Browsers never send the fragment, so a
# `#shlink:/...` URL cannot reach a log; but any `?shl=` / `?url=` convenience
# parameter would land in $request under the default `combined` format. $uri is
# the normalised path with the query string already removed.
log_format loupe_noquery '$remote_addr [$time_local] "$request_method $uri $server_protocol" '
                         '$status $body_bytes_sent $request_time';

server {
    # IPv4 only, on purpose: `kubectl port-forward` reaches the container as
    # TCP4:localhost:8080 from inside the pod netns, and a `listen [::]:8080`
    # that cannot bind takes the whole server down.
    listen      8080;
    server_name _;
    root        /usr/share/nginx/html;
    index       index.html;

    access_log  /dev/stdout loupe_noquery;
    server_tokens off;
    charset utf-8;

    # ---------------- compression ----------------
    gzip              on;
    gzip_vary         on;
    gzip_comp_level   6;
    gzip_min_length   1024;
    # text/html is always compressed and must not be listed here.
    gzip_types        text/plain text/css application/javascript application/json
                      application/manifest+json image/svg+xml application/wasm
                      application/octet-stream;
    # Serve the .gz files the build stage produced, in preference to compressing
    # on every request. Present in this image: pkg-oss builds nginx with
    # --with-http_gzip_static_module.
    gzip_static       on;
    #
    # Brotli is NOT enabled, and do not paste `brotli on;` in here: it is not a
    # built-in directive, and nginx treats an unknown directive as a fatal config
    # error, so the pod goes straight to CrashLoopBackOff. If it is ever wanted,
    # nginx publishes an official dynamic module for Alpine
    # (pkg-oss/alpine/Makefile.module-brotli → apk `nginx-module-brotli`), but
    # `load_module modules/ngx_http_brotli_filter_module.so;` and
    # `load_module modules/ngx_http_brotli_static_module.so;` are MAIN-context
    # directives: they have to be prepended to /etc/nginx/nginx.conf in a root
    # layer of the Dockerfile, they cannot live in conf.d. For a ~400 KB bundle
    # over a port-forward this buys nothing.

    # ---------------- one header set, server level ----------------
    add_header Cache-Control              $loupe_cache_control always;
    add_header X-Content-Type-Options     "nosniff"            always;
    add_header Referrer-Policy            "no-referrer"        always;
    add_header X-Frame-Options            "DENY"               always;
    add_header Cross-Origin-Opener-Policy "same-origin"        always;
    # camera=(self) is REQUIRED, not decoration: scanning an SHL QR code calls
    # getUserMedia, and `camera=()` would kill it. Everything else is off.
    add_header Permissions-Policy
        "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), serial=(), bluetooth=()"
        always;
    add_header Content-Security-Policy
        "default-src 'none'; \
         script-src 'self' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; \
         font-src 'self' data:; \
         connect-src 'self' https: http: data: blob:; \
         worker-src 'self' blob:; \
         manifest-src 'self'; \
         base-uri 'self'; \
         form-action 'none'; \
         frame-ancestors 'none'; \
         object-src 'none'"
        always;
    #
    # Deliberately NOT set:
    #   Strict-Transport-Security   (RFC 6797 §7.2: "An HSTS Host MUST NOT
    #     include the STS header field in HTTP responses conveyed over
    #     non-secure transport", and §8.1 has the UA ignore it anyway. The
    #     gateway adds HSTS for hosts that have one (charts/sparked-app
    #     httpRoute.hsts, on by default); this app has no host.
    #   Cross-Origin-Embedder-Policy: require-corp would break loading any
    #     third-party subresource and buys nothing without SharedArrayBuffer.

    # ---------------- routing ----------------
    # Hashed assets exist or 404. NEVER fall back to index.html here. If a stale
    # or renamed chunk fell through to the SPA fallback, the browser would get
    # HTML with a 200 and report
    #   "Failed to load module script: Expected a JavaScript module script but
    #    the server responded with a MIME type of text/html"
    # which reads as a bundler bug and is really a server-config bug.
    location /assets/ {
        try_files $uri =404;
    }

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    # SPA history fallback. See the `base` caveat in §4.1 before relying on it.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 4.1 The `base: './'` vs history-fallback contradiction, in the current repo

`shl-loupe/vite.config.ts` currently sets `base: './'`. That emits **relative** asset URLs
(`./assets/index-HASH.js`) in `index.html`. Combined with the SPA history fallback above, a deep
path route breaks: a request for `/trace/abcd` returns `index.html`, the browser resolves
`./assets/index-HASH.js` against `/trace/` and asks for `/trace/assets/index-HASH.js`, which
`location /assets/` never matches and `location /` answers with `index.html`, which is the exact
text/html MIME error quoted above.

Pick one, explicitly:

- **All app state in the fragment or the query, no path routes** (the natural shape here: an SHL
  already arrives as `#shlink:/…`). Then `base: './'` is right, the app is portable to any path
  prefix and even to `file://`, and the history fallback is harmless insurance.
- **Path-based routes** (`/trace`, `/manifest`, `/decrypt`). Then `base` must be `'/'`, and the
  fallback is load-bearing.

Do not ship `base: './'` plus real path routes.

### 4.2 CSP: what `connect-src` has to be, and the honest tension

The tool's entire job is to fetch attacker-supplied, participant-supplied, arbitrary origins.
So `connect-src` has to be effectively open:

```
connect-src 'self' https: http: data: blob:
```

- `https:` is the base case: SHL manifest `POST`s and every `files[].location` short-lived URL.
- `http:` is needed **for the debugger to be a debugger**. Refusing plain http would turn the
  motivating incident (`https://localhost:5173/api/shl-manifest?bid=4836470`) and its http
  cousins into an indistinguishable CSP violation instead of a diagnosable network error. A
  page served over `http://localhost:8080` has no mixed-content blocking, so http fetches
  genuinely work and the tool can report the real failure. (If a public HTTPS hostname is ever
  added, the browser blocks http subresources as mixed content regardless of CSP, and the tool
  must say so rather than blaming the link.)
- `data:` and `blob:` for pasted payloads and object URLs. Note that CSP3's `*` would **not**
  cover these (non-network schemes are excluded from `*`) while it **would** cover `ws:`/`wss:`,
  which this app never uses. So `https: http: data: blob:` is genuinely narrower than `*`, not
  just more verbose.

The tension is real and should be named in the repo, not papered over: **`connect-src` is not
the control that contains an XSS here, and cannot be.** The containment is:

- `default-src 'none'` plus explicit per-directive lists, so a directive nobody thought about
  fails closed.
- `script-src 'self' 'wasm-unsafe-eval'`, with no `'unsafe-inline'` and no `'unsafe-eval'`. This is the
  directive that decides whether attacker-controlled JS can run at all, and it is tight.
  `'wasm-unsafe-eval'` is the exact token needed by `zxing-wasm`'s
  `WebAssembly.instantiateStreaming`; it permits WASM compilation **without** re-enabling
  JavaScript `eval`.
- `object-src 'none'`, `base-uri 'self'` (blocks a `<base>` injection redirecting every relative
  asset), `form-action 'none'`, `frame-ancestors 'none'` (no clickjacking a decrypt button).
- `img-src` deliberately **excludes** `https:`. A FHIR `Attachment.url` or `Patient.photo`
  pointing at a remote image would otherwise be an uncontrolled beacon that fires just from
  rendering a payload. Render remote images only after an explicit user action, fetched through
  the same traced `fetch` path as everything else, and displayed from a `blob:`.
- `style-src 'self' 'unsafe-inline'` is the one concession. Tailwind v4 through
  `@tailwindcss/vite` emits a linked stylesheet, so try `style-src 'self'` first and only add
  `'unsafe-inline'` if a runtime style injection forces it. An inline-style bypass is a far
  smaller hole than an inline-script one.

Worth adding once the DOM sinks are known: `require-trusted-types-for 'script'` with
`trusted-types default`. It is the strongest available defence for a tool whose whole input is
untrusted third-party JSON being rendered into the DOM. There is no report endpoint (no
backend), so validate it by watching the console, not by report-only telemetry.

One nuance for the debugger's own explanations: CSP source lists are **not** re-matched after a
redirect, so a manifest URL that 302s to a blocked-looking origin will still complete. Do not
present a redirect chain as CSP-filtered.

### 4.3 Bundle the WASM, do not let it phone jsDelivr

Real finding, specific to this repo's `zxing-wasm@3.1.3` dependency. Its README, *Serving via
Web or CDN*: *"a `.wasm` binary file needs to be served somewhere ... the serve path is
automatically assigned a jsDelivr CDN URL upon build"*, resolving to
`https://fastly.jsdelivr.net/npm/zxing-wasm@<version>/dist/reader/zxing_reader.wasm`.

At a connectathon that is a runtime dependency on public internet and a third-party CDN for the
QR scanner, on exactly the venue wifi that will be behind a captive portal. Self-host it. The
package exports the binary as a subpath (`"./reader/zxing_reader.wasm"`), so Vite can emit it as
a hashed asset and it inherits the `immutable` cache header for free:

```ts
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { prepareZXingModule } from 'zxing-wasm/reader';

prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });
```

With that, `connect-src` never needs a CDN host and the scanner works offline.

---

## 5. Running it at an event: port-forward, and the secure-context question

### The command

```bash
kubectl --context sparkey -n shl-loupe port-forward svc/shl-loupe 8080:80
# → Forwarding from 127.0.0.1:8080 -> 8080
# → Forwarding from [::1]:8080 -> 8080
```

Then open **`http://localhost:8080`**.

`--context sparkey` is not optional. `sparked-argo`'s readme carries the warning that
`sparked-smile` is a different cluster and that
`kubectl config use-context arn:aws:eks:...` *"silently fails and leaves you on whatever context
was already active"*.

port-forward dies on pod restart and gives no retry flag, so for a demo:

```bash
while :; do kubectl --context sparkey -n shl-loupe port-forward svc/shl-loupe 8080:80; sleep 1; done
```

`svc/shl-loupe` (rather than a pod name) is correct: kubectl resolves the Service port 80 to the
backing pod's 8080 and picks a ready pod, so the command survives a redeploy that changes the pod
name.

### `http://localhost:8080` IS a secure context. Verified against the spec.

W3C *Secure Contexts*, §3.1 *Is origin potentially trustworthy?*, the numbered steps:

> 3. If origin's scheme is either "https" or "wss", return "Potentially Trustworthy".
> 4. If origin's host matches one of the CIDR notations `127.0.0.0/8` or `::1/128` [RFC4632],
>    return "Potentially Trustworthy".
> 5. If the user agent conforms to the name resolution rules in [let-localhost-be-localhost] and
>    one of the following is true: origin's host is "localhost" or "localhost."; origin's host
>    ends with ".localhost" or ".localhost.", then return "Potentially Trustworthy".
> 6. If origin's scheme is "file", return "Potentially Trustworthy".

and the closing note:

> Note: Neither origin's domain nor **port** has any effect on whether or not it is considered
> to be a secure context.

So `http://localhost:8080` and `http://127.0.0.1:8080` both qualify (steps 5 and 4), the port is
irrelevant, and therefore:

- **WebCrypto works.** `Crypto.subtle` is `[SecureContext]` in the Web Cryptography API IDL
  (§10.2.1: `[SecureContext] readonly attribute SubtleCrypto subtle;`), which is why in a
  non-secure context `crypto.subtle` is `undefined` rather than throwing. That is an important detail
  for the tool's own diagnostics, since a naive feature test reads as "this browser has no
  WebCrypto" when the real cause is the origin. An SHL viewer needs `crypto.subtle` for the
  `A256GCM` JWE decrypt and the `ES256` JWS verify, so this is load-bearing, not incidental.
- **`getUserMedia` (QR scanning) works**, same reason, given `Permissions-Policy` allows camera.

### `http://<LAN-IP>:8080` is NOT a secure context. This is the sharing trap.

`kubectl port-forward --address 0.0.0.0 …` will happily bind every interface so a colleague can
reach `http://192.168.1.42:8080`. **Do not do that at an event.** `192.168.1.42` is not in
`127.0.0.0/8` and is not `localhost`, so §3.1 falls through to step 9, "Not Trustworthy". On the
colleague's laptop: `crypto.subtle` is `undefined`, `navigator.mediaDevices` is `undefined`, and
your beautiful debugger fails in a way that looks like the debugger's fault. (RFC 6797 §8.1.1
independently confirms browsers refuse to treat bare IP hosts as HSTS hosts:
*"If the substring matching the host production ... syntactically matches the IP-literal or
IPv4address productions ... then the UA MUST NOT note this host as a Known HSTS Host."*)

Four ways to share, best first:

1. **They run their own port-forward.** Same command, their own kubectl context, their own
   `http://localhost:8080`. Secure context on both machines. Needs cluster access.
2. **`ssh -L` from their laptop to yours**, so the page is `localhost` **on their machine**:
   `ssh -L 8080:localhost:8080 you@your-mac` while your port-forward runs. Preserves the secure
   context, needs no cluster credentials, works over event wifi. This is the answer when a
   colleague at a connectathon table wants to poke at it.
3. **Give it a real hostname.** Flip `httpRoute.enabled: true` with
   `hostnames: ["loupe.fhir-examples.com"]`, add the listener + `Certificate` to
   `apps/common/networking/gateway-infra.yaml`, and cert-manager issues a Let's Encrypt cert.
   HTTPS everywhere, no caveats. This is the only real fix if it needs to be shared broadly, and
   it is a ~15 line change.
4. **Last resort, their browser, their risk.** Chrome
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (or
   `--unsafely-treat-insecure-origin-as-secure="http://192.168.1.42:8080"`), which is spec step 8,
   *"If origin has been configured as a trustworthy origin"*. Never recommend this as the primary
   path: it teaches exactly the wrong lesson at an interop event.

Bonus, worth knowing because it is genuinely useful: spec step 6 makes `file:` potentially
trustworthy, and Chrome and Firefox both implement it. So `pnpm build` and a zipped `dist/` is a
credible "here, run it yourself" handout, **but only if `base: './'` stays and there are no
path routes** (see §4.1). That is a good reason to keep the fragment-only architecture.

### One thing the tool should surface about itself

Given all of the above, Loupe should print its own environment in the trace panel:
`window.isSecureContext`, `typeof crypto.subtle`, `location.origin`. When a participant says
"decryption is broken", the first question is whether they opened it on `localhost` or on a LAN
IP, and the tool should answer that before anyone opens devtools.

---

## 6. Network policy: nothing blocks this pod, and it needs no egress

### Nothing exists for a `shl-loupe` namespace, so it is default-allow

Enforcement is genuinely on (`network-policies/README.md`: *"Network policy **enforcement is
ON** at the CNI (`enableNetworkPolicy=true` on the vpc-cni addon)"*), but it is per-namespace and
opt-in by file presence:

- `network-policies/phase1-ingress/`: `dev-inferno`, `distil`, `fhirflare`, `logimomo`,
  `ontoserver`, `prod-inferno`, `smile`, `sparked-test-data-loader`.
- `network-policies/phase2-egress-active/`: those eight plus `checkin-wellknown`, `clinic-demo`.

No `shl-loupe.yaml` in either, and none needed. The README states the mechanism: *"The synced
directory ... is the single source of which namespaces are enforced: a namespace's policies take
effect when its file is present here"*, and Kubernetes semantics do the rest (a pod selected by no
policy is unrestricted in both directions).

### The pod needs zero egress. Confirmed, not assumed.

The brief's instinct is exactly right and it is worth stating in the values file so nobody
"helpfully" adds an allow-list later:

- **The browser makes every SHL request, not the pod.** The manifest `POST`, each
  `files[].location` `GET`, and any terminology or FHIR lookup all originate from the viewer's
  own machine. The pod's entire job is to hand over `index.html` plus hashed assets that are
  already inside its own image layers.
- nginx here has no `proxy_pass`, no `resolver`, no `upstream`, no `auth_request`, no
  `sub_filter` fetching anything. There is no upstream to name.
- It needs no DNS either, which is unusual enough to be worth saying: even the baseline egress
  policies in `phase2-egress-active/` open UDP/TCP 53 to `kube-system/kube-dns` because *"every
  pod needs cluster DNS"*. This one does not resolve anything.
- With `zxing_reader.wasm` self-hosted (§4.3), there is no build-time-injected CDN dependency
  left to argue about at runtime either.

`network-policies/phase2-egress-active/checkin-wellknown.yaml` already documents the identical
situation for the sibling static-file app: *"checkin-wellknown is a static nginx file server ...
it originates no upstream calls, so DNS + the open external rule are more than its actual egress
footprint."* Same here, and even that is more than needed.

For completeness: the cluster-wide decision is that **external egress is open anyway** (README:
*"External egress is **unrestricted (all ports, any external host)** ... this cluster is
IG-standards dev/testing with synthetic data only (no PHI)"*), so even a mistakenly-added policy
would not have blocked an outbound HTTPS call.

### If someone later adds a phase-1 ingress file, one thing must be allowed

port-forward keeps working regardless, and the mechanism is worth knowing precisely rather than
relying on the docs' hedge. Kubernetes docs say only *"port-forwarding can provide direct network
access to workloads and may bypass network-level controls"*. The actual reason is the CRI
implementation: containerd's port-forward runs
`nsenter -t ${sandbox_pid} -n socat - TCP4:localhost:${target_port}` (newer containerd drops
socat for an in-process copy, same netns entry). The connection is therefore made **from inside
the pod's network namespace, over loopback**, and a CNI NetworkPolicy enforced at the pod's
veth/ENI boundary never sees it. This is also why the nginx `listen 8080;` (all addresses) matters:
a config bound to the pod IP only would refuse the loopback connection.

What would break is the **kubelet probe**, which comes from the node IP, not from a pod. Any
`shl-loupe` phase-1 file must therefore carry the node-CIDR allow, copying
`network-policies/phase1-ingress/distil.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: shl-loupe-allow-kubelet-probes
  namespace: shl-loupe
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: shl-loupe
      app.kubernetes.io/instance: shl-loupe
  policyTypes: [Ingress]
  ingress:
    - from:
        - ipBlock:
            cidr: 10.0.0.0/16
      ports:
        - protocol: TCP
          port: 8080
```

(The selector labels come from `charts/sparked-app/templates/_helpers.tpl`
`sparked-app.selectorLabels`, which emits `app.kubernetes.io/name` = fullname = release name and
`app.kubernetes.io/instance` = release name. There is **no** `app: shl-loupe` label; the raw-manifest
apps use that, chart-based ones do not.) No gateway-ingress rule is needed while there is no
HTTPRoute.

---

## 7. Order of operations

1. `aws ecr create-repository --repository-name sparked/shl-loupe --region ap-southeast-2 …`
2. Add `deploy/Dockerfile`, `deploy/nginx/default.conf`, `deploy/README.md` to `shl-loupe`;
   resolve the `base` question in `vite.config.ts` (§4.1); self-host the zxing WASM (§4.3).
3. `docker buildx build --platform linux/amd64 … --push` → `sparked/shl-loupe:v0.1.0`; verify the
   pushed manifest's `platform.architecture` is `amd64`.
4. In `sparked-argo`: run `scripts/new-app.sh --name shl-loupe --port 8080`, replace the
   generated `values.yaml` with §2b, replace the generated `apps/shl-loupe.yaml` with §2a, keep
   the AppProject edit it made, add the `readme.md` line.
5. `helm template shl-loupe charts/sparked-app -f apps/shl-loupe/values.yaml` → exactly a
   Deployment and a Service.
6. PR into `aehrc/main`, merge, ArgoCD syncs (`prune: true`, `selfHeal: true`).
7. `kubectl --context sparkey -n shl-loupe port-forward svc/shl-loupe 8080:80`, open
   `http://localhost:8080`.

### Do not

- Do not add anything to `apps/common/networking/gateway-infra.yaml`. No hostname, no listener,
  no `Certificate`, no external-dns record.
- Do not put a NetworkPolicy file in either `network-policies/` directory for this namespace.
- Do not add an `imagePullSecrets` entry.
- Do not add an `externalSecret` / `secretStore` / `crossplane` block. This app has no secrets by
  design: it is a static bundle, and everything sensitive it ever touches lives in the viewer's
  browser tab for the length of one session.
- Do not `docker build` without `--platform linux/amd64`.
- Do not use `--address 0.0.0.0` on the port-forward.
- Do not tag `:latest`. `charts/sparked-app/README.md`: *"pin a SHA, not `:latest`"*; the sibling
  apps pin `v0.5.0` / `v0.1.0` style tags and the values file is the deployment record.
