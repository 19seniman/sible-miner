# lim.js — CLI + auto-miner untuk mine.sible.network

Script Node.js tanpa dependency untuk login, cek status, dan **auto-mining tiap slot 3 jam dengan auto-accelerate**.

Butuh **Node.js 18+**. Tidak perlu `npm install`.

# 1) Install script
```
git clone https://github.com/19seniman/sible-miner.git
cd sible-miner
```

# 2) login — diminta password, lalu kode OTP dari email
```
node lim.js login --identifier emailkamu@mail.com --password 'passwordkamu'
```

# 3) Cek status
```
node lim.js status
```

# 4) Jalankan mining 

```
node lim.js auto 
```

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
