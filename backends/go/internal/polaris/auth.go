package polaris

import (
	"bytes"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"image/png"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const passwordIterations = 600000

var usernamePattern = regexp.MustCompile(`^[a-z0-9_.-]{2,32}$`)

func constantEqual(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func digest(v string) string         { return fmt.Sprintf("%x", sha256.Sum256([]byte(v))) }
func hashPassword(password string) string {
	salt := []byte(token(16))
	key, err := pbkdf2.Key(sha256.New, password, salt, passwordIterations, 32)
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("pbkdf2$%d$%s$%s", passwordIterations, base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(key))
}
func verifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	n, e := strconv.Atoi(parts[1])
	if e != nil || n < 1 || n > 2000000 {
		return false
	}
	salt, e := base64.StdEncoding.DecodeString(parts[2])
	if e != nil {
		return false
	}
	expected, e := base64.StdEncoding.DecodeString(parts[3])
	if e != nil || len(expected) != 32 {
		return false
	}
	actual, e := pbkdf2.Key(sha256.New, password, salt, n, 32)
	return e == nil && subtle.ConstantTimeCompare(expected, actual) == 1
}

func (a *App) bearer(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	return a.config.AdminToken != "" && len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") && constantEqual(header[7:], a.config.AdminToken)
}
func (a *App) user(r *http.Request) Object {
	cookie, e := r.Cookie("polaris_session")
	if e != nil {
		return nil
	}
	session, e := a.store.get(r.Context(), "session", digest(cookie.Value))
	if e != nil || session == nil || integer(session, "expires_at") <= time.Now().Unix() {
		return nil
	}
	user, _ := a.store.get(r.Context(), "user", str(session, "user_id"))
	return user
}
func (a *App) authorized(r *http.Request) bool { return a.bearer(r) || a.user(r) != nil }
func publicUser(u Object) any {
	if u == nil {
		return nil
	}
	return Object{"id": u["id"], "username": u["username"]}
}
func (a *App) setCookie(w http.ResponseWriter, r *http.Request, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: "polaris_session", Value: value, Path: "/", HttpOnly: true, Secure: r.TLS != nil || a.config.TrustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"), SameSite: http.SameSiteLaxMode, MaxAge: age})
}

// 客户端持有原始随机令牌，数据库只保存摘要与过期时间。
// Keep the random session token in the client cookie; store only its digest and expiry.
func (a *App) createSession(w http.ResponseWriter, r *http.Request, id string) (int64, error) {
	secret := token(32)
	settings, err := a.settings(r.Context())
	if err != nil {
		return 0, err
	}
	age := int(number(settings["security.sessionTtlDays"])) * 86400
	expires := time.Now().Unix() + int64(age)
	err = a.store.put(r.Context(), "session", digest(secret), Object{"user_id": id, "expires_at": expires})
	if err == nil {
		a.setCookie(w, r, secret, age)
	}
	return expires, err
}

func (a *App) authRoutes() {
	a.route("GET /api/auth/session", true, func(w http.ResponseWriter, r *http.Request) error {
		users, e := a.store.list(r.Context(), "user")
		if e != nil {
			return e
		}
		needs := len(users) == 0
		var credential any
		var database any
		if needs {
			dbType := "sqlite"
			if a.store.postgres {
				dbType = "postgres"
			}
			database = Object{"types": []string{"sqlite", "postgres"}, "defaultType": dbType, "postgresConfigured": a.store.postgres, "postgresUrlEditable": true}
			if a.config.SetupKey != "" {
				credential = "SETUP_KEY"
			} else if a.config.AdminToken != "" {
				credential = "ADMIN_TOKEN"
			}
		}
		u := a.user(r)
		respond(w, 200, Object{"authenticated": u != nil || a.bearer(r), "user": publicUser(u), "needsSetup": needs, "setupCredential": credential, "setupDatabase": database})
		return nil
	})
	a.route("POST /api/auth/setup", true, func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		expected := a.config.SetupKey
		if expected == "" {
			expected = a.config.AdminToken
		}
		if expected == "" {
			return failure("credential_unconfigured", 503)
		}
		if !constantEqual(str(b, "credential"), expected) {
			return failure("invalid_setup_credential", 401)
		}
		name := strings.ToLower(strings.TrimSpace(str(b, "username")))
		if !usernamePattern.MatchString(name) {
			return failure("invalid_username", 400)
		}
		password := str(b, "password")
		if len(password) < 8 {
			return failure("password_too_short", 400)
		}
		if len(password) > 4096 {
			return failure("invalid_request", 400)
		}
		u := Object{"id": uuid(), "username": name, "password_hash": hashPassword(password), "created_at": time.Now().Unix()}
		if e = a.finishDatabaseSetup(w, r, b, u); e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true, "user": publicUser(u)})
		return nil
	})
	a.route("POST /api/auth/login", true, func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		name := strings.ToLower(strings.TrimSpace(str(b, "username")))
		password := str(b, "password")
		if name == "" || password == "" || len(password) > 4096 {
			return failure("invalid_credentials", 401)
		}
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		keys := []string{digest("ip:" + ip), digest("account:" + name)}
		now := time.Now().Unix()
		settings, e := a.settings(r.Context())
		if e != nil {
			return e
		}
		window := int64(number(settings["security.loginWindowSec"]))
		max := int64(number(settings["security.loginMaxAttempts"]))
		locked := false
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			for _, key := range keys {
				limit, e := t.get("login_limit", key)
				if e != nil {
					return e
				}
				if limit == nil || now-integer(limit, "started") >= window {
					limit = Object{"started": now, "count": 0}
				}
				limit["count"] = integer(limit, "count") + 1
				if integer(limit, "count") > max {
					locked = true
				}
				if e = t.put("login_limit", key, limit); e != nil {
					return e
				}
			}
			return nil
		})
		if e != nil {
			return e
		}
		if locked {
			return failure("invalid_credentials", 401)
		}
		users, e := a.store.list(r.Context(), "user")
		if e != nil {
			return e
		}
		var u Object
		for _, row := range users {
			if str(row, "username") == name {
				u = row
				break
			}
		}
		stored := "pbkdf2$600000$cG9sYXJpcy1kdW1teS1zYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
		if u != nil {
			stored = str(u, "password_hash")
		}
		if !verifyPassword(password, stored) || u == nil {
			return failure("invalid_credentials", 401)
		}
		if e = a.store.mutate(r.Context(), func(t *transaction) error {
			for _, key := range keys {
				if e := t.remove("login_limit", key); e != nil {
					return e
				}
			}
			return nil
		}); e != nil {
			return e
		}
		expires, e := a.createSession(w, r, str(u, "id"))
		if e != nil {
			return e
		}
		respond(w, 200, Object{"ok": true, "user": publicUser(u), "expiresAt": expires})
		return nil
	})
	a.route("POST /api/auth/logout", true, func(w http.ResponseWriter, r *http.Request) error {
		if c, e := r.Cookie("polaris_session"); e == nil {
			if e = a.store.mutate(r.Context(), func(t *transaction) error { return t.remove("session", digest(c.Value)) }); e != nil {
				return e
			}
		}
		a.setCookie(w, r, "", -1)
		respond(w, 200, Object{"ok": true})
		return nil
	})
	a.route("POST /api/auth/account", false, func(w http.ResponseWriter, r *http.Request) error {
		u := a.user(r)
		if u == nil {
			return failure("unauthorized", 401)
		}
		b, e := body(r)
		if e != nil {
			return e
		}
		next := str(b, "next")
		name := strings.ToLower(strings.TrimSpace(str(b, "username")))
		if next == "" && name == "" {
			return failure("no_change", 400)
		}
		if next != "" && len(next) < 8 {
			return failure("password_too_short", 400)
		}
		if name != "" && !usernamePattern.MatchString(name) {
			return failure("invalid_username", 400)
		}
		if len(next) > 4096 {
			return failure("invalid_request", 400)
		}
		if !verifyPassword(str(b, "current"), str(u, "password_hash")) {
			return failure("invalid_credentials", 401)
		}
		e = a.store.mutate(r.Context(), func(t *transaction) error {
			stored, e := t.get("user", str(u, "id"))
			if e != nil {
				return e
			}
			if stored == nil || str(stored, "password_hash") != str(u, "password_hash") {
				return failure("invalid_credentials", 401)
			}
			if name != "" {
				stored["username"] = name
			}
			if next != "" {
				stored["password_hash"] = hashPassword(next)
				sessions, e := t.list("session")
				if e != nil {
					return e
				}
				for _, s := range sessions {
					if str(s, "user_id") == str(u, "id") {
						_, e = t.tx.Exec(t.store.query(`DELETE FROM polaris_documents WHERE kind='session' AND data=?`), encode(s))
						if e != nil {
							return e
						}
					}
				}
			}
			u = stored
			return t.put("user", str(u, "id"), u)
		})
		if e != nil {
			return e
		}
		if next != "" {
			if _, e = a.createSession(w, r, str(u, "id")); e != nil {
				return e
			}
		}
		respond(w, 200, Object{"ok": true, "username": u["username"]})
		return nil
	})
	for _, method := range []string{"GET", "POST", "DELETE"} {
		a.route(method+" /api/auth/avatar", false, a.avatar)
	}
	a.route("GET /api/auth/avatar/image", false, a.avatar)
}

func (a *App) avatar(w http.ResponseWriter, r *http.Request) error {
	u := a.user(r)
	if u == nil {
		return failure("unauthorized", 401)
	}
	id := str(u, "id")
	o, e := a.store.get(r.Context(), "avatar", id)
	if e != nil {
		return e
	}
	if r.Method == "POST" {
		raw, e := io.ReadAll(io.LimitReader(r.Body, 384*1024+1))
		if e != nil {
			return e
		}
		if len(raw) > 384*1024 {
			return failure("too_large", 413)
		}
		if !bytes.HasSuffix(raw, []byte{0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130}) {
			return failure("avatar_invalid", 400)
		}
		info, e := png.DecodeConfig(bytes.NewReader(raw))
		if e != nil || info.Width < 1 || info.Height < 1 || info.Width > 512 || info.Height > 512 {
			return failure("avatar_invalid", 400)
		}
		if _, e = png.Decode(bytes.NewReader(raw)); e != nil {
			return failure("avatar_invalid", 400)
		}
		o = Object{"image": base64.StdEncoding.EncodeToString(raw), "version": uuid()}
		if e = a.store.put(r.Context(), "avatar", id, o); e != nil {
			return e
		}
	}
	if r.Method == "DELETE" {
		if e = a.store.mutate(r.Context(), func(t *transaction) error { return t.remove("avatar", id) }); e != nil {
			return e
		}
		o = nil
	}
	if strings.HasSuffix(r.URL.Path, "/image") {
		if o == nil {
			return failure("not_found", 404)
		}
		raw, _ := base64.StdEncoding.DecodeString(str(o, "image"))
		w.Header().Set("Content-Type", "image/png")
		_, e = w.Write(raw)
		return e
	}
	if o == nil {
		respond(w, 200, Object{"uploaded": false, "url": nil})
	} else {
		respond(w, 200, Object{"uploaded": true, "url": "/api/auth/avatar/image?v=" + str(o, "version")})
	}
	return nil
}
