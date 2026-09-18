# Fiszki

A single-user Polish production trainer. Dictate a Polish word you just met; it
comes back as a Russian → Polish card on an FSRS schedule.

Design: `docs/superpowers/specs/2026-09-12-polish-srs-design.md`

## Setup

```bash
npm install
cp .env.example .env.local   # fill in APP_PASSWORD, SESSION_SECRET, GOOGLE_CLOUD_PROJECT, FISZKI_MODEL
openssl rand -hex 32         # SESSION_SECRET
gcloud auth application-default login   # the only credential step; there are no API keys
npm test
npm run build
npm start
```

There is no API key for any of the three Google services. Authentication is
Application Default Credentials: your own login locally, the VM's attached
service account in production.

## Deploying to the VM

A Compute Engine VM in a European region — it matters, because Polish
Speech-to-Text is served from the `eu` multi-region endpoint. `europe-west1`
and `europe-central2` (Warsaw) are both fine.

The steps below are manual (run them yourself from a workstation with
`gcloud` and `tailscale` installed and `gcloud auth login`'d as a project
owner); nothing here is scripted end to end, because most of it — creating a
bucket, granting IAM roles, formatting a disk — is a one-time action that a
script would only make riskier to re-run by accident.

### 1. Create the project-level things

```bash
# The bucket backups land in. Do this once.
gcloud storage buckets create gs://<project>-fiszki-backups --location=europe-west1

# The service account the VM runs as. No keys are ever created for it — the
# VM's attached identity is the credential.
gcloud iam service-accounts create fiszki --display-name="Fiszki app"

SA="serviceAccount:fiszki@<project>.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding <project> --member="$SA" --role=roles/aiplatform.user
gcloud projects add-iam-policy-binding <project> --member="$SA" --role=roles/speech.client
gcloud storage buckets add-iam-policy-binding gs://<project>-fiszki-backups \
  --member="$SA" --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://<project>-fiszki-backups \
  --member="$SA" --role=roles/storage.objectViewer
```

Exactly those four bindings. Nothing else. Two of them are not obvious, and both
were learned from a real deploy rather than from the docs:

**There is no Cloud Text-to-Speech role.** An earlier version of this file told
you to grant `roles/cloudtts.client`, which does not exist —
`gcloud projects add-iam-policy-binding` rejects it with
`INVALID_ARGUMENT: Role roles/cloudtts.client is not supported for this
resource`, and `gcloud iam roles list` finds no text-to-speech role at all.
Synthesis is not gated by per-resource IAM: with the API enabled, any
authenticated caller in the project can synthesize. Confirmed the hard way —
Cloud TTS was the one provider that passed `npm run check-providers` on a
service account holding *zero* roles, while Speech-to-Text and Gemini both
returned `PERMISSION_DENIED`.

**`objectCreator` alone is not enough to upload a backup.** It looks like it
should be — the script only ever creates objects — but `gcloud storage cp`
issues an existence `GET` on the destination first, so with creator-only
access it fails with `403 ... does not have storage.objects.get access`, before
writing anything. `objectViewer` is the minimal addition that fixes it; it adds
read, not delete, so a compromised VM still cannot erase your backup history.
`roles/storage.objectUser` would also work and is one binding instead of two,
but it grants delete as well, which defeats the point of an offsite copy.

### 2. Create the VM and its data disk

```bash
gcloud compute instances create fiszki \
  --zone=europe-west1-b --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --service-account=fiszki@<project>.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --create-disk=name=fiszki-data,size=10GB,type=pd-balanced,auto-delete=no
```

Two things about that command are load-bearing. `--service-account` with
`--scopes=cloud-platform` is what makes the app keyless — the metadata server
supplies credentials for Gemini, Speech-to-Text and Text-to-Speech, scoped
down to the bindings actually granted above. And `auto-delete=no` on the
data disk means the database outlives the VM — delete or rebuild the VM and
the disk survives; only deleting the disk itself loses data. The boot disk is
disposable, the data disk is not.

### 3. Format and mount the data disk (manual, on the VM)

```bash
sudo mkfs.ext4 -m 0 /dev/disk/by-id/google-fiszki-data
sudo mkdir -p /mnt/fiszki
echo '/dev/disk/by-id/google-fiszki-data /mnt/fiszki ext4 discard,defaults 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo mkdir -p /mnt/fiszki/backups
```

The `/etc/fstab` line is what turns `/mnt/fiszki` into the systemd mount unit
`mnt-fiszki.mount` that the app and backup units below depend on. Run
`mkfs.ext4` exactly once — it destroys whatever was on the disk before, which
the first time is nothing.

### 4. Install Node 22, clone the app, install and build

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs sqlite3
sudo useradd --system --home /opt/fiszki --shell /usr/sbin/nologin fiszki
sudo mkdir -p /opt/fiszki
sudo git clone <this repo> /opt/fiszki   # or: scp/rsync a release tarball
cd /opt/fiszki
sudo npm ci
sudo npm run build
sudo chown -R fiszki:fiszki /opt/fiszki /mnt/fiszki
```

### 5. Write `/etc/fiszki.env`

```bash
sudo tee /etc/fiszki.env >/dev/null <<'EOF'
APP_PASSWORD=<pick one>
SESSION_SECRET=<openssl rand -hex 32>
FISZKI_DB=/mnt/fiszki/fiszki.db
GOOGLE_CLOUD_PROJECT=<project>
FISZKI_MODEL=<gemini model id, see .env.example>
GCP_VERTEX_LOCATION=global
GCP_SPEECH_LOCATION=eu
FISZKI_BACKUP_BUCKET=<project>-fiszki-backups
# The new-card daily cap and "today" boundary in lib/review/queue.ts roll
# over at server-local midnight. A default GCE Debian image runs UTC, which
# would roll the cap over at 02:00 Warsaw time instead of midnight.
TZ=Europe/Warsaw
EOF
sudo chmod 600 /etc/fiszki.env
```

This is the only place any of these values live on the VM — not in the repo,
not in an image, not in a key file. `FISZKI_DB` pointing at `/mnt/fiszki/`
rather than the checkout is what keeps the database off the disposable boot
disk.

### 6. Install the systemd units

```bash
sudo cp scripts/deploy/fiszki.service scripts/deploy/fiszki-backup.service \
        scripts/deploy/fiszki-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fiszki.service
sudo systemctl enable --now fiszki-backup.timer
```

`fiszki.service` will not start before `/mnt/fiszki` is mounted (see
"Systemd mount ordering" below) — starting early would create an empty
database on the boot disk and serve an empty deck, silently. It restarts on
failure. `fiszki-backup.timer` fires the backup once a day and, because it is
`Persistent=true`, also fires once shortly after any boot where the VM was
off at the scheduled time.

### 7. Tailscale — no public ingress

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=fiszki
# Enable HTTPS for the tailnet ONCE, before the next line:
#   https://login.tailscale.com/admin/dns -> "Enable HTTPS"
sudo tailscale serve --bg http://localhost:3000
tailscale serve status
```

Two notes on that `serve` line. The older `serve --bg https / http://localhost:3000`
form is gone; today's CLI rejects it and prints the shorter replacement. And
`serve` needs tailnet HTTPS turned on first, because it provisions a real
certificate for `<host>.<tailnet>.ts.net`. If HTTPS is off, `serve` does not
fail with a clear message — it simply hangs waiting for a certificate it can
never get, and `tailscale serve status` keeps reporting `No serve config`.
Check with `tailscale status --json | grep CertDomains`: `null` means HTTPS is
still disabled.

Do not open 80 or 443 in the VM's firewall. There is no firewall rule to add
here — the point is the absence of one. Tailscale's `serve` gives a real
certificate on a `*.ts.net` hostname, which the microphone, the service
worker and home-screen install all require — a plain `http://10.x.x.x`
address would disable the app's central feature.

Open the printed URL on the phone, log in with `APP_PASSWORD`, then Chrome
menu → *Add to Home screen*.

## Live provider smoke-check

`scripts/check-providers.ts` makes one real call to each of the three Google
services — Cloud TTS, then Speech-to-Text v2 transcribing that TTS clip back,
then Gemini generating one card — and checks something about each response,
not just that it returned without throwing:

```bash
npm run check-providers
```

Run this **first**, right after the systemd units come up, before touching
the phone. It exists because each provider module's real network wiring was
previously verified exactly once, by hand, with a probe script that was then
deleted — and every one of the three provider tasks shipped a defect
(a wrong client version, a `require()` in an ESM project) that was invisible
to unit tests and only showed up in that since-deleted manual step. This
script is that check, kept instead of thrown away, so it can be re-run after
every deploy. It needs ADC and `GOOGLE_CLOUD_PROJECT`/`FISZKI_MODEL` in the
environment (it reads `.env.local` itself if present, since a standalone
script does not get Next.js's automatic env loading); on the VM,
`source /etc/fiszki.env` first — and note that `/etc/fiszki.env` is mode 600
and root-owned, so `sudo -u fiszki ... $(grep ... /etc/fiszki.env)` fails on the
`grep`, not on the app. Load it as root, then drop privileges:

```bash
sudo bash -c 'set -a; . /etc/fiszki.env; set +a; cd /opt/fiszki; \
  exec sudo -E -u fiszki npm run check-providers'
```

A partially-loaded environment is worth spotting quickly, because it fails in a
misleading way: with no `GOOGLE_CLOUD_PROJECT` or `FISZKI_MODEL`, Speech-to-Text
and Gemini report *"is not set"* while Cloud TTS still passes, which looks like
two broken providers rather than one unreadable file.

## Backup

```bash
./scripts/backup.sh            # locally: writes backups/fiszki-YYYY-MM-DD-HHMM.db
FISZKI_BACKUP_BUCKET=my-bucket ./scripts/backup.sh   # on the VM: uploads to GCS
```

One file holds the cards, the review history, the dictation audio
and the TTS clips. It is taken with `VACUUM INTO`, a consistent snapshot of
the live database, not a plain file copy — a copy of an open WAL database can
capture a torn state. On the VM the timer runs this nightly and the snapshot
lands in Cloud Storage; a snapshot left on the same disk as the database
would not be a backup — it survives a corrupt write and nothing else, not a
deleted VM or a lost disk. If the upload fails, the script exits non-zero and
**keeps the local snapshot** rather than deleting it; see "Systemd mount
ordering" note below for the analogous reasoning applied to the app unit.

## Systemd mount ordering

`fiszki.service` and `fiszki-backup.service` both set:

```
After=network-online.target mnt-fiszki.mount
Wants=network-online.target
RequiresMountsFor=/mnt/fiszki
```

`After=` on its own only orders startup relative to the mount unit — it does
not require the mount to have *succeeded*. A slow, failing, or not-yet
`/etc/fstab`-registered mount would still let `After=` be satisfied and the
app would start against a plain empty directory on the boot disk, creating a
fresh empty `fiszki.db` there and serving an empty deck with no error
anywhere. `RequiresMountsFor=/mnt/fiszki` is systemd's purpose-built
mechanism for exactly this: it resolves the path to its backing mount unit
from `/etc/fstab`, and adds both an ordering *and* a requirement dependency
on it automatically — the service will not start unless that mount is
actually active. `After=...mnt-fiszki.mount` is kept alongside it only as
documentation of intent; `RequiresMountsFor` is what actually enforces it.

## Known assumption: the unawaited capture pipeline under `next start`

`POST /api/captures` returns `{captureId}` immediately and runs the pipeline
in an unawaited `void processCapture(...)` — its own comment notes this would
be unsafe on a serverless host that can freeze or kill the process the moment
the response is sent. Spec §10 deploys `next start` under systemd on a
persistent VM specifically so that assumption holds: the Node process keeps
running, event loop and all, long after the HTTP response for `/api/captures`
has gone out, exactly as it would under `next dev`.

That said, this has only ever been exercised against `npm run dev` in
development and in the automated test suite (which invokes the same
in-process function directly, not through a real HTTP round-trip against a
`next start` server). It has never been confirmed against a real `next start`
process serving a real request over the network. The post-deploy checklist
below covers confirming it once.

## Post-deploy checklist

Do these once, in order, after the VM first comes up. Each one is either
cheap to check now and expensive to discover broken later, or is the one
thing genuinely new about this environment versus everything tested so far.

1. **`npm run check-providers`.** Confirms Speech-to-Text v2, Gemini, and
   Cloud TTS are all reachable and returning sane output through ADC and the
   VM's service account — before anything phone-shaped can go wrong.
2. **`/dodaj` — hold, dictate one real Polish word, release, confirm a card
   appears.** This is the *first* time real `MediaRecorder` webm/opus audio
   from an actual phone microphone reaches the transcriber. Every automated
   test and the smoke-check above only ever sends Cloud-TTS-generated MP3
   through that path. It also confirms the unawaited capture pipeline
   (previous section) survives a real `next start` process handling a real
   request, not just `npm run dev`.
3. **`/powtorki`** — the new card appears, reveal shows the Russian prompt,
   audio plays, rate it.
4. **Run the backup** (`sudo systemctl start fiszki-backup.service` or wait
   for the timer) **and confirm the object lands in the bucket**:
   `gcloud storage ls gs://<bucket>/`.
5. **Reboot the VM** (`gcloud compute instances reset fiszki`) **and confirm
   the app comes back by itself with the same cards**, with no manual step.
   A deployment that needs a human after every reboot is not deployed — this
   is the check that `RequiresMountsFor` actually did its job instead of the
   app quietly recreating an empty database on the boot disk.

## Environment

| Variable | Purpose |
|---|---|
| `APP_PASSWORD` | the single passphrase |
| `SESSION_SECRET` | HMAC key for the session cookie |
| `FISZKI_DB` | database path; `/mnt/fiszki/fiszki.db` on the VM |
| `GOOGLE_CLOUD_PROJECT` | the GCP project for all three AI services |
| `FISZKI_MODEL` | Gemini model ID; default `gemini-3.8-flash` (newer generation over nominally-higher-tier `gemini-2.5-pro`, spec §5). **Do not fall back to a 2.5 model** — see below |
| `GCP_VERTEX_LOCATION` | Gemini location, default `global` |
| `GCP_SPEECH_LOCATION` | Speech/TTS location, default `eu` — Polish requires it |
| `FISZKI_BACKUP_BUCKET` | GCS bucket for snapshots; unset means local-only |

No API keys. Every Google call uses Application Default Credentials.

### The model is load-bearing for Russian dictation

`FISZKI_MODEL` used to name `gemini-2.5-pro` as a fallback "if generation
quality regresses". Measured, after `fromDictation` began accepting either
language, all three asked to make a card from the Russian word «склеп» (a
crypt), which is a near-homophone of Polish `sklep` (a shop):

```
gemini-3.8-flash   prompt_ru="склеп"    answer_pl="grobowiec"   correct
gemini-2.5-pro     prompt_ru="магазин"  answer_pl="sklep"       wrong direction
gemini-2.5-flash   prompt_ru="магазин"  answer_pl="sklep"       wrong direction
```

Both 2.5 models read the Cyrillic as if it were the Polish look-alike and
built the card backwards. Falling back to one would not degrade Russian
dictation, it would silently invert it — and the result looks like a perfectly
ordinary card, so nothing would flag it.

Latency is worth knowing too: the same calls took 30s, 46s and 2.4s. A
`gemini-3.8-flash` request that takes half a minute is normal here, and
intermittent `429 RESOURCE_EXHAUSTED` from it is common enough that two
consecutive re-recognitions hit it. A 429 leaves the card `needs_input`, which
`wygeneruj ponownie` repairs.

## Not built yet

Audio mode — hands-free playback of Russian prompt, silence, Polish answer —
is specified in §6 of the design and deliberately not implemented. The TTS
groundwork it needs is already here.
