# sible.mjs — CLI + auto-miner untuk mine.sible.network

Script Node.js tanpa dependency untuk login, cek status, dan **auto-mining tiap slot 3 jam dengan auto-accelerate**.

Butuh **Node.js 18+**. Tidak perlu `npm install`.

---

## 1. Setup

```bash
cp .env.example .env
```

Isi `.env` — **pilih salah satu** cara login:

```dotenv
# cara 1: email/username + password
SIBLE_IDENTIFIER=emailkamu@mail.com
SIBLE_PASSWORD=passwordkamu
```

```dotenv
# cara 2: bearer token
SIBLE_TOKEN=eyJhbGciOi...
```

Atau biarkan script yang menulis `.env` untukmu:

```bash
# dari email + password
node sible.mjs login --identifier emailkamu@mail.com --password 'passwordkamu'

# dari bearer token
node sible.mjs login --token 'eyJhbGciOi...'
```

Kalau akun belum verifikasi email, tambahkan `--otp 123456`.

Cek isi `.env` kapan pun (password/token disamarkan):

```bash
node sible.mjs env
```

File `.env` dibuat dengan permission `600`, dan sudah masuk `.gitignore`.

### Ambil bearer token dari browser

Buka `https://mine.sible.network`, login, tekan **F12** → tab **Network** → klik request apa pun ke `prod.sible.network` → copy header `Authorization: Bearer eyJ...`.

Token expired otomatis di-refresh lewat `/auth/refresh`, dan token baru **ditulis balik ke `.env`** — jadi kamu tidak perlu login ulang selama refresh token masih hidup.

---

## 2. Auto mining + auto accelerate

```bash
node sible.mjs auto
```

Yang dilakukan tiap iterasi:

1. **Cek status** — kalau tidak ada slot berjalan, panggil `POST /mining/start`.
2. **Auto accelerate** — panggil `POST /mining/ad` berulang sampai `adsWatched` mencapai `adMaxPerSession` (default server, biasanya 3) atau `canWatchAd` habis. Tiap ad menaikkan `adBoostPct`.
3. **Auto claim** — saat slot selesai (`canClaim`), klaim dan tunggu settlement (`pending` → `completed`).
4. **Mulai slot baru** langsung, lalu tidur sampai event berikutnya (ad berikutnya atau slot habis), maksimal 1 jam per bangun supaya clock tetap sinkron dengan server.
5. **Hormati kuota harian** — kalau `slotsUsedToday >= slotsPerDay`, tunggu sampai tengah malam UTC.

Opsi:

```bash
node sible.mjs auto --slot-hours 3      # paksa panjang slot 3 jam (default: dari server)
node sible.mjs auto --max-ads 5         # batasi accelerate per sesi
node sible.mjs auto --no-ad             # mining saja tanpa accelerate
node sible.mjs auto --once              # satu putaran lalu keluar (cocok untuk cron)
node sible.mjs auto --once --dry-run    # lihat rencana, tidak mengirim transaksi
```

Contoh jalan terus di background:

```bash
nohup node sible.mjs auto > sible-auto.log 2>&1 &
tail -f sible-auto.log
```

Stop: `Ctrl+C`, atau `pkill -f "sible.mjs auto"`.

---

## 3. Command lain

| Command | Fungsi |
|---|---|
| `login` | simpan kredensial/token ke `.env` |
| `logout` | hapus token dari `.env` (email/password tetap) |
| `env` | tampilkan `.env` (disamarkan) |
| `me` | profil akun |
| `status` | status mining: total, sisa slot, progress, ads, boost |
| `start` | mulai slot |
| `claim` | klaim slot |
| `ad` | accelerate manual 1× |
| `tasks` | daftar reward task |
| `claim-task <id>` | klaim reward task (`--day-key YYYY-MM-DD`) |
| `referral` | ringkasan referral |
| `apply-ref <CODE>` | terapkan kode referral |
| `get <path>` / `post <path> '<json>'` | panggil endpoint apa pun |

Flag: `--json`, `--env <file>`.

---

## 4. API yang dipakai

Base: `https://prod.sible.network/api/v1`, header `X-Client-Type: web`.

```
POST /auth/login            {identifier, password}   → {accessToken, refreshToken, user}
POST /auth/verify-otp       {email, code, purpose}
POST /auth/refresh          {refreshToken}
POST /auth/logout           {refreshToken}
GET  /users/me
GET  /mining/status
POST /mining/start
POST /mining/claim          → {claimId, status:"pending"|"completed", amount?}
GET  /mining/claim/:id
POST /mining/ad             → {session:{adsWatched, adBoostPct}}   ← accelerate
GET  /reward-tasks
POST /reward-tasks/:id/claim {dayKey}
GET  /referral/overview | /breakdown | /members
POST /referral/apply        {code}
```

Field penting `/mining/status`: `totalAmount`, `currentSessionAmount`, `currentSecondReward`, `slotStartsAt`, `slotEndsAt`, `serverTime`, `canClaim`, `canWatchAd`, `slotLengthHours`, `slotsPerDay`, `slotsUsedToday`, `adMaxPerSession`, `currentHourlyReward`, `session.{id,isRunning,endsAt,nextAdAt,adsWatched,adBoostPct}`.

Error yang ditangani: `INVALID_CREDENTIALS`, `TOKEN_INVALID`, `SESSION_CHANGED`, `ACCOUNT_LOCKED`, `ACCOUNT_BANNED`, `MINING_SLOT_ALREADY_USED`.

---

## 5. Uji lokal (tanpa akun asli)

`test/mock-server.mjs` meniru API di atas, berguna untuk memverifikasi logika tanpa menyentuh akun sungguhan:

```bash
node test/mock-server.mjs 8787 &
# di terminal lain:
printf 'SIBLE_IDENTIFIER=tester@mail.com\nSIBLE_PASSWORD=secret123\nSIBLE_API_BASE=http://127.0.0.1:8787/api/v1\n' > /tmp/t.env
SIBLE_ENV_FILE=/tmp/t.env node sible.mjs auto --once
```

Untuk simulasi slot cepat, jalankan mock dengan `SLOT_SEC=6`.

---

## 6. Catatan

- Script hanya memanggil API web app dengan token akunmu sendiri — tidak menyentuh wallet, private key, atau seed phrase.
- Kode referral `Wolfalliance` valid (`/auth/referral-code?code=Wolfalliance` → `exists: true`); dipakai saat mendaftar akun baru, bukan lewat script ini.
- Jangan set interval lebih rapat dari ~15 detik; server punya rate limit dan bisa menandai akun.
- `.env` berisi kredensial: jangan commit, jangan share screenshot isinya.

---

## 7. Pengaman (anti-pola-bot)

Script ini dirancang jadi klien yang **sopan**, bukan yang menyamar. Semua bisa diatur di `.env`:

| Pengaman | Default | Env |
|---|---|---|
| Jeda minimal antar request tulis | 4000 ms | `SIBLE_MIN_GAP_MS` |
| Jitter acak pada jeda | ±25% | `SIBLE_JITTER_PCT` |
| Retry dengan backoff eksponensial | 4× dari 5 s | `SIBLE_MAX_RETRIES`, `SIBLE_BACKOFF_MS` |
| Hormati `Retry-After` saat 429/5xx | otomatis | — |
| Timeout request | 20 s | `SIBLE_TIMEOUT_MS` |
| Kunci proses (tolak instance kedua) | aktif di `auto` | — |
| Kuota harian lokal | ad 30 / claim 10 / start 10 | `SIBLE_DAILY_*_CAP` |
| Jeda acak antar-ad | 2,2–4,8 s | — |
| Header klien web resmi | UA + Origin + Referer | `SIBLE_USER_AGENT`, `SIBLE_ACCEPT_LANGUAGE` |

Kuota harian ini **bukan** angka server — sengaja lebih ketat, supaya kalau server longgar pun polanya tidak ekstrem. Kalau kuota lokal habis, script berhenti sendiri:

```
LOCAL_DAILY_CAP: kuota ads harian habis (30/30) — script berhenti sendiri demi keamanan akun
```

Counter disimpan di `.sible-state.json` (reset otomatis saat tanggal UTC berganti), dan `auto` memakai `.sible.lock` sehingga dua instance tidak bisa jalan bersamaan:

```
✖ ALREADY_RUNNING: proses lain masih jalan (pid 2073). Hentikan dulu: kill 2073
```

Yang **tidak** dilakukan — dan sebaiknya jangan ditambahkan:

- rotasi proxy/IP atau multi-akun (pola yang paling cepat memicu ban),
- bypass captcha/challenge,
- spoofing fingerprint TLS (JA3) atau rotasi User-Agent tiap request,
- interval di bawah ~15 detik untuk mengejar reward.

Tidak ada jaminan bebas dari deteksi: kalau platform mengubah aturan atau memasang challenge, script bisa berhenti atau akun kena tindakan. Pengaman di atas memastikan kalau itu terjadi, penyebabnya bukan karena script menembak terlalu cepat.
