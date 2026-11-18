# auto-miner untuk mine.sible.network

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
node lim.js login --identifier emailkamu@mail.com --password 'passwordkamu'
```
**4. Verifikasi**

```powershell
node lim.js status
```

**5. Jalankan Mining**

```powershell
node lim.js auto
```

