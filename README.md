# lim.js — CLI + auto-miner untuk mine.sible.network

Script Node.js tanpa dependency untuk login, cek status, dan **auto-mining tiap slot 3 jam dengan auto-accelerate**.

Butuh **Node.js 18+**. Tidak perlu `npm install`.



## 0. Jalankan cepat (Termux, dari nol sampai mining)

Salin berurutan. Ganti email/password dengan milikmu.

```bash
# 1) dependensi (sekali saja)
pkg update && pkg install nodejs git nano termux-api -y

# 2) ambil script
git clone https://github.com/19seniman/sible-miner.git
cd sible-miner

# 3) login — diminta password, lalu kode OTP dari email
node lim.js login

# 4) pastikan token valid
node lim.js status

# 5) mulai auto-mining di background
termux-wake-lock
nohup node lim.js auto > sible-auto.log 2>&1 &

# 6) pantau
tail -f sible-auto.log


Setelah langkah 5, tidak ada yang perlu dijalankan tiap 3 jam — script mengurus siklus slot sendiri.

Kalau akunmu tidak pakai OTP, langkah 3 bisa langsung:

```bash
node lim.js login --identifier emailkamu@mail.com --password 'passwordkamu'
```

---

## 1. Setup

Ada tiga cara, pilih yang paling nyaman. Semuanya berakhir sama: `.env` berisi kredensial, permission `600`.

### Cara A — tanpa editor (paling anti-error, cocok untuk Termux)

```bash
node lim.js setup
```

Script menanyakan pilihan login (email+password atau bearer token), lalu menulis `.env` sendiri. Kredensial diuji dulu sebelum disimpan — kalau salah, `.env` lama tidak ditimpa.

Versi satu baris:

```bash
node lim.js setup --identifier emailkamu@mail.com --password 'passwordkamu'
node lim.js setup --token 'eyJhbGciOi...'
```

### Cara B — `nano .env` (seperti repo pXb)

File `.env` **otomatis dibuat** oleh script kalau belum ada, lengkap dengan template dan komentar. Jadi cukup:

```bash
node lim.js          # sekali saja, untuk membuat .env
nano .env
```

Isi bagian yang relevan, lalu simpan di nano:

```
Ctrl + O   → Enter   (simpan)
Ctrl + X             (keluar)
```

**Catatan penting:** perintahnya `nano .env` — titik dan `env` **menempel**, tanpa spasi. Kalau ditulis `nano . env` (pakai spasi), yang dibuat adalah file bernama `env`, bukan `.env`, dan script tidak akan membacanya.

Kalau `nano` belum ada di Termux:

```bash
pkg update && pkg install nano -y
```

Atau pakai editor yang sudah terpasang (`vim`/`vi` dideteksi otomatis), atau langsung:

```bash
node lim.js edit      # buka .env di editor, buat dulu kalau belum ada
```

### Cara C — lewat `login`

```bash
node lim.js login --identifier emailkamu@mail.com --password 'passwordkamu'
node lim.js login --token 'eyJhbGciOi...'
```

### Login yang butuh kode OTP

Sebagian akun membalas `{needsOtp: true, email, resendAfterSec}` — artinya login belum selesai sampai kode dari email dimasukkan. Script menanganinya otomatis:

```bash
node lim.js login            # ditanya kode OTP langsung
node lim.js login --otp 123456   # versi non-interaktif
node lim.js login --resend       # minta kode baru kalau sudah kedaluwarsa
```

Script mencoba `purpose` `login` lalu `verify_email`, karena server tidak mendokumentasikan yang mana. Kalau kode salah, semua percobaan gagal dengan pesan `OTP_FAILED` — tidak ada token yang tersimpan.

### Isi `.env` yang diharapkan

```dotenv
# cara 1: email/username + password
SIBLE_IDENTIFIER=emailkamu@mail.com
SIBLE_PASSWORD=passwordkamu

# cara 2: bearer token (kosongkan kalau pakai cara 1)
SIBLE_TOKEN=
SIBLE_REFRESH_TOKEN=
```

### Kalau `nano .env` terbuka kosong

Itu tanda file `.env` ada tapi isinya 0 byte (mis. pernah disimpan sebagai buffer kosong). Keluar dari nano, jalankan sekali, lalu buka lagi:

```bash
node lim.js     # isi template dimasukkan otomatis ke .env yang kosong
nano .env
```

Cek kondisinya kapan pun:

```bash
ls -la .env     # ukuran file
node lim.js env # ringkasan isi; bilang "(belum ada kredensial terisi)" kalau masih kosong
```

File yang **sudah ada isinya** tidak pernah ditimpa otomatis.

### Verifikasi

```bash
ls -a                 # .env tersembunyi, harus muncul di sini
node lim.js env       # isi .env, password/token disamarkan
node lim.js status    # tes login + lihat status mining
```

`ls` biasa tidak menampilkan file berawalan titik — itu bukan tanda file gagal dibuat.

### Kenapa `.env` tidak di-commit ke repo

Di repo `pXb`, `.env` ikut di-commit dengan placeholder `PRIVATE_KEY=0x`. Pola itu rawan: begitu kamu isi nilai asli dan menjalankan `git add -A`, kredensial ikut ter-push.

Di repo ini `.env` ada di `.gitignore` dan **tidak** pernah di-commit. Supaya tetap nyaman dipakai, file-nya dibuat otomatis saat pertama kali script dijalankan, jadi `nano .env` tetap langsung bisa dipakai tanpa risiko bocor.

Kalau perlu berbagi template, pakai `.env.example` (isinya placeholder saja).

### Ambil bearer token dari browser

Buka `https://mine.sible.network`, login, tekan **F12** → tab **Network** → klik request apa pun ke `prod.sible.network` → copy header `Authorization: Bearer eyJ...`.

Token expired otomatis di-refresh lewat `/auth/refresh`, dan token baru **ditulis balik ke `.env`** — jadi kamu tidak perlu login ulang selama refresh token masih hidup.

---

## 2. Auto mining + auto accelerate

```bash
node lim.js auto
```

Yang dilakukan tiap iterasi:

1. **Cek status** — kalau tidak ada slot berjalan, panggil `POST /mining/start`.
2. **Auto accelerate** — panggil `POST /mining/ad` berulang sampai `adsWatched` mencapai `adMaxPerSession` (default server, biasanya 3) atau `canWatchAd` habis. Tiap ad menaikkan `adBoostPct`.
3. **Auto claim** — saat slot selesai (`canClaim`), klaim dan tunggu settlement (`pending` → `completed`).
4. **Mulai slot baru** langsung, lalu tidur sampai event berikutnya (ad berikutnya atau slot habis), maksimal 1 jam per bangun supaya clock tetap sinkron dengan server.
5. **Hormati kuota harian** — kalau `slotsUsedToday >= slotsPerDay`, tunggu sampai tengah malam UTC.

Opsi:

```bash
node lim.js auto --slot-hours 3      # paksa panjang slot 3 jam (default: dari server)
node lim.js auto --max-ads 5         # batasi accelerate per sesi
node lim.js auto --no-ad             # mining saja tanpa accelerate
node lim.js auto --once              # satu putaran lalu keluar (cocok untuk cron)
node lim.js auto --once --dry-run    # lihat rencana, tidak mengirim transaksi
```

Contoh jalan terus di background:

```bash
nohup node lim.js auto > sible-auto.log 2>&1 &
tail -f sible-auto.log
```

Stop: `Ctrl+C`, atau `pkill -f "lim.js auto"`.

---

### Menjalankan di Termux (detail)

**Sebelum ditinggal lama:**

```bash
termux-wake-lock                  # cegah Android mematikan Termux saat layar mati
```

Lalu di Android: **Settings → Apps → Termux → Battery → Unrestricted**, dan biarkan notifikasi Termux tetap muncul. Tanpa ini, `nohup` pun bisa ikut mati saat HP deep sleep.

**Start / stop / restart:**

```bash
# start di background
nohup node lim.js auto > sible-auto.log 2>&1 &

# lihat log (Ctrl+C hanya keluar dari tail, miner tetap jalan)
tail -f sible-auto.log

# stop
pkill -f "lim.js auto"
```

**Log yang sehat:**

```
5:50:12 PM auto-miner aktif — mode LIVE, auto-accelerate ON
5:50:12 PM   pengaman: jeda 4000ms ±25% · retry 4× · ad 0/30 · claim 0/10 · start 0/10
5:50:12 PM idle → start() slot 3 jam
5:50:13 PM   session sess_8f21 berjalan
5:50:18 PM   accelerate 1/3 → boost 5%
5:50:52 PM total 53.22 · slot-ini 0.0021 · sisa 2h 59m · ads 3/3
5:50:52 PM   tidur 59m 59s
```

**Jangan jalankan dua instance.** Script menolak sendiri:

```
✖ ALREADY_RUNNING: proses lain masih jalan (pid 2073). Hentikan dulu: kill 2073
```

**Kalau proses mati (HP restart / Termux ditutup):**

```bash
cd ~/sible-miner
termux-wake-lock
nohup node lim.js auto > sible-auto.log 2>&1 &
```

Token tetap tersimpan di `.env`, jadi tidak perlu login ulang selama refresh token masih hidup.

**Alternatif berbasis cron** (kalau lebih suka dijalankan berkala):

```bash
pkg install cronie -y
crontab -e
```

```cron
0 */3 * * * cd ~/sible-miner && /data/data/com.termux/files/usr/bin/node lim.js auto --once >> sible-auto.log 2>&1
```

`auto` biasa tetap lebih baik: dia tahu jadwal `nextAdAt` dan slot, jadi tidak menembak di tengah siklus.

---

### Menjalankan di Windows (PowerShell)

Script-nya murni Node.js tanpa dependency, jadi jalan apa adanya di Windows — tidak ada `chmod`, `pkill`, atau `nohup`.

**1. Pasang Node.js (sekali saja)**

```powershell
winget install OpenJS.NodeJS.LTS
```

Atau unduh installer LTS dari https://nodejs.org. Tutup lalu buka ulang PowerShell supaya `node` terbaca.

**2. Ambil script**

```powershell
cd $HOME
git clone https://github.com/19seniman/sible-miner.git
cd sible-miner
```

Tanpa git: buka repo → **Code → Download ZIP** → extract → `cd` ke folder hasil extract.

**3. Login**

```powershell
node lim.js login
```

Ditanya password lalu kode OTP, sama seperti di Termux. Versi tanpa prompt:

```powershell
node lim.js login --identifier emailkamu@mail.com --password 'passwordkamu'
```

**4. Verifikasi**

```powershell
node lim.js status
```

**5. Jalankan di background**

PowerShell tidak punya `nohup`, jadi pakai `Start-Process`:

```powershell
Start-Process -FilePath "node" -ArgumentList "lim.js","auto" `
  -RedirectStandardOutput "auto.log" -RedirectStandardError "auto.err" `
  -WindowStyle Hidden
```

Catatan: `Start-Process` tidak boleh mengarahkan stdout dan stderr ke file yang sama.

**6. Pantau log**

```powershell
Get-Content auto.log -Tail 20         # 20 baris terakhir
Get-Content auto.log -Tail 20 -Wait   # ikuti terus, Ctrl+C untuk keluar
```

**7. Cek proses & hentikan**

```powershell
# cek apakah jalan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*lim.js*" } |
  Select-Object ProcessId, CommandLine

# hentikan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*lim.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Jangan pakai `Stop-Process -Name node` — itu mematikan semua proses Node di laptopmu.

**8. Supaya laptop tidak sleep saat mining**

```powershell
powercfg /change standby-timeout-ac 0     # colok listrik: jangan sleep
powercfg /change monitor-timeout-ac 15    # layar tetap mati setelah 15 menit
```

Kalau laptop ditutup, Windows biasanya suspend — ubah lid action:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /S SCHEME_CURRENT
```

**9. Autostart saat login (opsional)**

```powershell
schtasks /create /tn "sible-miner" /sc onlogon /f ^
  /tr "cmd /c cd /d %USERPROFILE%\sible-miner && node lim.js auto >> auto.log 2>&1"
```

Hapus lagi dengan `schtasks /delete /tn "sible-miner" /f`.

**Bedanya dengan Termux:** tidak ada `termux-wake-lock`; yang perlu diurus adalah sleep dan lid close di atas. Selain itu perintah `node lim.js …` identik.

`node lim.js edit` di Windows otomatis membuka Notepad, dan `.env` yang disimpan Notepad (UTF-8 + BOM, CRLF) tetap terbaca.

---

## 3. Command lain

| Command | Fungsi |
|---|---|
| `setup` | wizard isi `.env` tanpa editor (uji dulu, baru simpan) |
| `edit` | buka `.env` di `nano`/`$EDITOR`, dibuat otomatis kalau belum ada |
| `login` | simpan kredensial/token ke `.env` (`--otp`, `--resend` untuk akun ber-OTP) |
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

Flag: `--json`, `--env <file>`, `--debug` (tampilkan request/response mentah, nilai sensitif disamarkan).

Kalau `login` balas `NO_TOKEN`, jalankan `node lim.js login --debug` untuk melihat isi respons server. Kalau server meminta verifikasi e-mail, script akan meminta kode OTP dan mengirimnya ke `/auth/verify-otp`; versi non-interaktif: `node lim.js login --otp 123456`.

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
SIBLE_ENV_FILE=/tmp/t.env node lim.js auto --once
```

Untuk simulasi slot cepat, jalankan mock dengan `SLOT_SEC=6`.

---

## 6. Catatan

- Script hanya memanggil API web app dengan token akunmu sendiri — tidak menyentuh wallet, private key, atau seed phrase.
- Kode referral `Wolfalliance` valid (`/auth/referral-code?code=Wolfalliance` → `exists: true`); dipakai saat mendaftar akun baru, bukan lewat script ini.
- Jangan set interval lebih rapat dari ~15 detik; server punya rate limit dan bisa menandai akun.
- `.env` berisi kredensial: jangan commit, jangan share screenshot isinya.
- Selama refresh token hidup, `auto` memperbarui access token sendiri. Kalau refresh token mati **dan** server meminta OTP, `auto` tidak bisa memasukkan kode secara otomatis — dia berhenti dengan `SESSION_EXPIRED`. Jalankan `node lim.js login` sekali, lalu start `auto` lagi.
- Kalau muncul `LOCAL_DAILY_CAP`, itu batas aman lokal (ad 30 / claim 10 / start 10 per hari), bukan kerusakan. Naikkan lewat `.env` kalau paham risikonya.

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
