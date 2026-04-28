# Insighta Labs+ — Backend

Secure demographic intelligence API. Extends Stage 2 with authentication, role-based access control, GitHub OAuth with PKCE, JWT session management, CSV export, rate limiting, and request logging.

**Live URL**: https://insighta-backend-ten.vercel.app

---

## System Architecture

```
insighta-backend  ←─── insighta-cli  (Bearer token)
      │
      └──────────────── insighta-web  (HTTP-only cookies)
      │
      └──────────────── PostgreSQL (Neon)
```

Three repositories share one backend. CLI uses `Authorization: Bearer` headers. The web portal uses HTTP-only cookies. All data lives in a single PostgreSQL database.

---

## Authentication Flow

### CLI (PKCE)
```
1. CLI generates: state, code_verifier, code_challenge = sha256(code_verifier)
2. CLI opens browser → GET /auth/github?state=X&code_challenge=Y&cli_redirect=http://localhost:9876/callback
3. Backend stores { state → code_challenge } in pkce_states table
4. Backend redirects to GitHub OAuth
5. GitHub redirects → GET /auth/github/callback?code=Z&state=X
6. Backend looks up state → redirects to CLI local server: http://localhost:9876/callback?code=Z&state=X
7. CLI captures code, validates state
8. CLI → POST /auth/token { code, code_verifier, state }
9. Backend: verifies sha256(code_verifier) == stored code_challenge
10. Backend exchanges code with GitHub → gets user info → issues access + refresh tokens
11. CLI stores tokens at ~/.insighta/credentials.json
```

### Web Portal
```
1. User clicks "Continue with GitHub"
2. GET /auth/github → backend generates state → redirects to GitHub
3. GitHub → GET /auth/github/callback?code=Z&state=X
4. Backend exchanges code, creates/updates user, sets HTTP-only cookies
5. Redirects to /dashboard on web portal
```

---

## Token Handling

| Token | Expiry | Storage |
|---|---|---|
| Access token | 3 minutes | JWT (signed with JWT_SECRET) |
| Refresh token | 5 minutes | Opaque string in PostgreSQL |

- Refresh tokens are **single-use** — consumed and replaced on every `/auth/refresh` call
- Expired refresh tokens are rejected with 401
- Logout invalidates the refresh token server-side

---

## Role Enforcement

| Role | Permissions |
|---|---|
| `admin` | Full access: read, create, delete profiles |
| `analyst` | Read-only: list, get, search, export profiles |

Default role: `analyst`

All `/api/*` endpoints require:
1. Valid `Authorization: Bearer <token>` header (CLI) or `access_token` cookie (web)
2. `X-API-Version: 1` header
3. Active user account (`is_active = true`)

Role checks are applied via `requireRole('admin')` middleware on write endpoints.

---

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| GET | `/auth/github` | Start OAuth flow |
| GET | `/auth/github/callback` | GitHub OAuth callback |
| POST | `/auth/token` | Exchange code (CLI PKCE) |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Invalidate session |
| GET | `/auth/me` | Current user info |

### Profiles (requires auth + X-API-Version: 1)
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/profiles` | any | List with filters, sort, pagination |
| GET | `/api/profiles/search?q=` | any | Natural language search |
| GET | `/api/profiles/export?format=csv` | any | Export CSV |
| GET | `/api/profiles/:id` | any | Get single profile |
| POST | `/api/profiles` | admin | Create profile |
| DELETE | `/api/profiles/:id` | admin | Delete profile |

---

## CLI Usage

Install and use via the [insighta-cli](https://github.com/Gospelmairo/insighta-cli) repo.

```bash
# Install globally
npm install -g .

# Login via GitHub OAuth (opens browser)
insighta login

# Show current user and role
insighta whoami

# List profiles (paginated)
insighta profiles list
insighta profiles list --limit 5 --page 2
insighta profiles list --gender female --country NG

# Natural language search
insighta profiles search "young males from nigeria"
insighta profiles search "females above 30 from kenya"

# Logout
insighta logout
```

Tokens are stored at `~/.insighta/credentials.json`. The CLI auto-refreshes the access token on expiry and prompts re-login if the refresh token is also expired.

---

## Natural Language Parsing

Rule-based parsing only — no AI or LLMs.

| Query | Maps to |
|---|---|
| `young males from nigeria` | gender=male, min_age=16, max_age=24, country_id=NG |
| `females above 30` | gender=female, min_age=30 |
| `adult males from kenya` | gender=male, age_group=adult, country_id=KE |
| `teenagers below 18` | age_group=teenager, max_age=18 |

**Keywords:**
- Gender: male/males/men, female/females/women
- Age groups: child/children, teenager/teen, adult, senior/elderly
- "young" → min_age=16, max_age=24
- `above/over/older than N` → min_age=N
- `below/under/younger than N` → max_age=N
- `from/in <country>` → country_id lookup

**Limitations:**
- Country adjectives (Nigerian, Kenyan) not supported — use full country name
- Typos return "Unable to interpret query"
- "young" cannot be combined with an explicit age_group keyword

---

## Rate Limiting

| Scope | Limit |
|---|---|
| `/auth/*` | 10 requests / minute |
| `/api/*` | 60 requests / minute per user |

Returns `429 Too Many Requests` when exceeded.

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing JWTs |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `BACKEND_URL` | This server's public URL |
| `FRONTEND_URL` | Web portal URL (for CORS + redirects) |
