# ISK Doorlock v2

Smart Door Lock Control System - Web-based MQTT control panel untuk mengelola pintu pintar dengan monitoring dan scheduling.

## Features

- 🚪 **Door Control** - Kontrol buka/kunci pintu via MQTT real-time
- 🔧 **Chip Management** - Kelola chip (nomor chip + MAC address) yang di-assign ke pintu
- 📊 **Health Monitoring** - Tracking PING heartbeat (12 jam interval + 4 menit toleransi)
- 📈 **Performance Metrics** - Jumlah PING 1 hari & 7 hari terakhir per kamar
- ⏰ **Scheduling** - Automated door open/close berdasarkan jadwal
- 👥 **Role-Based Access** - Admin (control) vs Superadmin (full access)
- 📡 **Real-time Updates** - Server-Sent Events (SSE) untuk live updates
- 🐳 **Docker Ready** - Full Docker & Docker Compose support

## Tech Stack

- **Backend**: Node.js + Express.js + PostgreSQL
- **IoT Protocol**: MQTT v5.0
- **Frontend**: Vanilla JavaScript (no framework)
- **Authentication**: bcrypt + express-session
- **Deployment**: Docker + Docker Compose
- **Timezone**: Luxon untuk timezone-aware scheduling

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (untuk development)

### Installation

1. Clone repository:
```bash
git clone https://github.com/ivanadhii/isk-doorlock-v2.git
cd isk-doorlock-v2
```

2. Build dan jalankan dengan Docker:
```bash
make fresh-build
```

3. Create default users (opsional):
```bash
make user
```

4. Akses aplikasi:
- Web UI: http://localhost:3000
- Login dengan user default (jika sudah create users)

### Makefile Commands

```bash
make fresh-build   # Clean rebuild (stop, remove, build, start)
make build         # Quick rebuild
make user          # Create default users
make db-logs       # Stream database logs
make logs          # Stream app logs
make down          # Stop containers
make restart       # Full restart with rebuild
```

## Konfigurasi untuk Deployment yang Berbeda

### Jumlah Pintu & Lantai Berbeda

Sistem ini **tidak hard-coded** untuk 44 pintu. Kamu bisa deploy untuk berapa saja pintu dengan konfigurasi berikut:

#### 1. Ubah Environment Variable di `docker-compose.yml`

```yaml
environment:
  # Tentukan lantai mana saja yang digunakan (comma-separated)
  FLOORS: "1,2,3,4,5"  # Contoh: 5 lantai

  # Atau misalnya hanya lantai tertentu:
  FLOORS: "1,3,5,7"    # Skip lantai 2,4,6
```

#### 2. Input Pintu via Admin Panel

Jumlah pintu **tidak perlu dikonfigurasi di code**. Kamu input langsung di admin panel:

**Contoh Deployment 52 Pintu (Gedung Lain):**

1. Buka halaman Admin → Door Manager
2. Tambah chip sesuai jumlah yang dibutuhkan (52 chips)
3. Tambah door/kamar:
   - Lantai 1: Kamar 101, 102, ..., 110 (10 pintu)
   - Lantai 2: Kamar 201, 202, ..., 210 (10 pintu)
   - Lantai 3: Kamar 301, 302, ..., 316 (16 pintu)
   - Lantai 4: Kamar 401, 402, ..., 416 (16 pintu)
   - **Total: 52 pintu**

Sistem akan otomatis menyesuaikan dengan jumlah data yang kamu input!

### Multi-Gedung/Lokasi (MQTT Topic Prefix)

Kalau deploy untuk beberapa gedung dengan MQTT broker yang sama:

```yaml
environment:
  # Gedung Jatinegara
  MQTT_TOPIC_PREFIX: "jatinegara"

  # Gedung Kemayoran
  MQTT_TOPIC_PREFIX: "kemayoran"

  # Gedung Tanah Abang
  MQTT_TOPIC_PREFIX: "tanah-abang"
```

Setiap gedung akan punya namespace MQTT terpisah:
- `jatinegara/lantai1/control`
- `kemayoran/lantai1/control`
- `tanah-abang/lantai1/control`

### Timezone Berbeda

```yaml
environment:
  TZ: "Asia/Jakarta"      # WIB (default)
  # TZ: "Asia/Makassar"   # WITA
  # TZ: "Asia/Jayapura"   # WIT
  # TZ: "Asia/Singapore"  # SGT
```

### MQTT Broker Custom

```yaml
environment:
  MQTT_HOST: "mqtt://your-broker.com"
  MQTT_PORT: 1883
  MQTT_USERNAME: "your-username"
  MQTT_PASSWORD: "your-password"
```

### Scheduler Interval

```yaml
environment:
  # Check schedule setiap 30 detik (default)
  SCHEDULER_TICK_SECONDS: 30

  # Atau lebih cepat/lambat:
  SCHEDULER_TICK_SECONDS: 10   # 10 detik
  SCHEDULER_TICK_SECONDS: 60   # 1 menit
```

## Database Schema

### Tables

- `users` - Authentication (admin/superadmin)
- `chips` - Chip registry (nomor chip + MAC address)
- `doors` - Door registry (floor, room_no, chip_id)
- `command_logs` - Command tracking dengan ACK latency
- `ping_logs` - Health check PING history
- `schedules` - Automated scheduling
- `session` - Express session storage

### Relasi

```
chips (1) ---< (N) doors
doors (1) ---< (N) command_logs
doors (1) ---< (N) ping_logs
doors (1) ---< (N) schedules
```

## API Endpoints

### Authentication
- `POST /api/login` - Login
- `GET /api/me` - Get current user
- `POST /api/logout` - Logout

### Chips (Superadmin only)
- `GET /api/chips` - List all chips
- `POST /api/chips` - Create chip
- `DELETE /api/chips/:id` - Delete chip

### Doors
- `GET /api/doors` - List all doors (dengan chip info)
- `POST /api/doors` - Create door (superadmin)
- `PUT /api/doors/:id` - Update door (superadmin)
- `DELETE /api/doors/:id` - Delete door (superadmin)

### Commands
- `POST /api/send` - Send command to door (admin/superadmin)

### Schedules
- `GET /api/schedules` - List schedules
- `POST /api/schedules/upsert` - Create/update schedule
- `DELETE /api/schedules/:id` - Delete schedule

### Monitoring (Superadmin only)
- `GET /api/health` - Health status (last PING)
- `GET /api/metrics/ping-count` - PING count 1d/7d
- `GET /api/metrics/downtime-today` - Daily downtime estimate

### Real-time
- `GET /api/events` - Server-Sent Events stream

## MQTT Protocol

### Topic Structure

```
{MQTT_TOPIC_PREFIX}/lantai{n}/control   # Server → Doors: Commands
{MQTT_TOPIC_PREFIX}/lantai{n}/status    # Doors → Server: ACK
{MQTT_TOPIC_PREFIX}/lantai{n}/health    # Doors → Server: PING
```

### Message Format

**Command (Server → Doors):**
```
buka,84:CC:A8:82:43:D0      # Open door dengan MAC tersebut
kunci,84:CC:A8:82:43:D0     # Lock door dengan MAC tersebut
```

**ACK (Doors → Server):**
```
ACK,84:CC:A8:82:43:D0,buka  # Acknowledge command buka
ACK,84:CC:A8:82:43:D0,kunci # Acknowledge command kunci
```

**PING (Doors → Server):**
```
PING,84:CC:A8:82:43:D0      # Heartbeat every 12 hours
```

## Health Check Parameters

- **PING Interval**: 12 jam (720 menit)
- **Toleransi**: 4 menit
- **Unhealthy Threshold**: > 724 menit tidak ada PING
- **Downtime Calculation**: Gap PING > 724 menit dihitung sebagai downtime

## Development

### Local Development (tanpa Docker)

1. Install dependencies:
```bash
npm install
```

2. Setup PostgreSQL database

3. Set environment variables:
```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/isk_doorlock"
export SESSION_SECRET="your-secret"
export MQTT_HOST="mqtt://gatevans.com"
# ... dst
```

4. Run:
```bash
npm start
```

### Create Users Manually

```bash
node tools/create_users.js
```

Default credentials (jika menggunakan env vars):
- Admin: `admin` / `ADMIN_PASSWORD`
- Superadmin: `superadmin` / `SUPERADMIN_PASSWORD`

## Security Notes

⚠️ **IMPORTANT untuk Production:**

1. Ubah `SESSION_SECRET` di `docker-compose.yml`
2. Ubah password default admin/superadmin via env vars
3. Jangan commit file `.env` atau credentials ke repository
4. Gunakan HTTPS untuk production deployment
5. Restrict akses database port (5432) dari public
6. Update MQTT credentials secara berkala

## Deployment Examples

### Example 1: Kost 52 Kamar (3 Lantai)

```yaml
environment:
  FLOORS: "1,2,3"
  MQTT_TOPIC_PREFIX: "kost-melawai"
```

Setup via Admin Panel:
- Tambah 52 chips
- Tambah 52 doors (distribusi lantai sesuai kebutuhan)

### Example 2: Apartemen 100 Unit (10 Lantai)

```yaml
environment:
  FLOORS: "1,2,3,4,5,6,7,8,9,10"
  MQTT_TOPIC_PREFIX: "apt-sudirman"
```

Setup via Admin Panel:
- Tambah 100 chips
- Tambah 100 doors (10 unit per lantai)

### Example 3: Multi-Property Management

Deploy multiple instances dengan MQTT broker yang sama tapi topic prefix berbeda:

**Property A:**
```yaml
MQTT_TOPIC_PREFIX: "property-a"
DATABASE_URL: "postgres://...db-property-a..."
```

**Property B:**
```yaml
MQTT_TOPIC_PREFIX: "property-b"
DATABASE_URL: "postgres://...db-property-b..."
```

## License

Private project - ISK Doorlock System

## Support

Untuk pertanyaan atau issue, silakan contact tim development.

---

**Built with ❤️ using Node.js, Express, PostgreSQL, and MQTT**
#   i s k - d o o r l o c k - v 2  
 