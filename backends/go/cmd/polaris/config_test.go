// 验证启动参数、环境变量与 dotenv 优先级。
// Check startup flags, environment, and dotenv precedence.

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStartupConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("# example\nexport POLARIS_ADDR='127.0.0.1:1' # comment\nPOLARIS_SETUP_KEY=\"a b\\nquoted\"\nPOLARIS_DATABASE_URL='postgres://name:pass@host/db?x=1#part'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	values, err := loadEnvFile(path)
	if err != nil || values["POLARIS_SETUP_KEY"] != "a b\nquoted" || !strings.Contains(values["POLARIS_DATABASE_URL"], "#part") {
		t.Fatalf("dotenv parsing: %v", err)
	}
	if err = os.WriteFile(path, []byte("POLARIS_SETUP_KEY=\"secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = loadEnvFile(path); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("invalid file not safely rejected")
	}
	if err = os.WriteFile(path, []byte("POLARIS_ADDR=127.0.0.1:1\nPOLARIS_CONCURRENCY=not-an-integer\n"), 0600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "polaris")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	environ := []string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "POLARIS_") {
			environ = append(environ, entry)
		}
	}
	start := func(dataDir string, extra ...string) (*exec.Cmd, <-chan string) {
		t.Helper()
		args := []string{"-addr", "127.0.0.1:0", "-data-dir", dataDir, "-concurrency", "2"}
		cmd := exec.Command(binary, args...)
		cmd.Dir = dir
		cmd.Env = append(append([]string{}, environ...), extra...)
		pipe, e := cmd.StderrPipe()
		if e != nil {
			t.Fatal(e)
		}
		if e = cmd.Start(); e != nil {
			t.Fatal(e)
		}
		lines := make(chan string, 20)
		go func() {
			defer close(lines)
			s := bufio.NewScanner(pipe)
			for s.Scan() {
				lines <- s.Text()
			}
		}()
		t.Cleanup(func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
			}
		})
		return cmd, lines
	}
	readUntilReady := func(lines <-chan string) (string, string) {
		t.Helper()
		var log string
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("server exited before ready: %s", log)
				}
				log += line + "\n"
				if strings.Contains(line, "Go listening") {
					match := regexp.MustCompile(`address=([^ ]+)`).FindStringSubmatch(line)
					if len(match) != 2 {
						t.Fatalf("no listen address: %s", line)
					}
					return match[1], log
				}
			case <-time.After(30 * time.Second):
				t.Fatalf("startup timeout: %s", log)
			}
		}
	}
	cmd, lines := start(filepath.Join(dir, "data"), "POLARIS_ADDR=127.0.0.1:2", "POLARIS_CONCURRENCY=invalid")
	addr, log := readUntilReady(lines)
	match := regexp.MustCompile(`setup_key=([A-Za-z0-9_-]{43})`).FindStringSubmatch(log)
	if len(match) != 2 {
		t.Fatalf("generated key missing: %s", log)
	}
	payload, _ := json.Marshal(map[string]string{"credential": match[1], "username": "admin", "password": "correct-horse-battery"})
	resp, err := http.Post("http://"+addr+"/api/auth/setup", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("setup: %d %s", resp.StatusCode, body)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	cmd.Process = nil
	_, lines = start(filepath.Join(dir, "data"))
	_, log = readUntilReady(lines)
	if strings.Contains(log, "setup_key=") {
		t.Fatal("generated key after setup")
	}
	if err = os.WriteFile(path, []byte("POLARIS_CONCURRENCY=2\nPOLARIS_SETUP_KEY='file-secret'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	configured, configuredLines := start(filepath.Join(dir, "configured"), "POLARIS_SETUP_KEY=process-secret")
	configuredAddr, configuredLog := readUntilReady(configuredLines)
	if strings.Contains(configuredLog, "setup_key=") || strings.Contains(configuredLog, "process-secret") || strings.Contains(configuredLog, "file-secret") {
		t.Fatal("configured key leaked")
	}
	payload, _ = json.Marshal(map[string]string{"credential": "process-secret", "username": "admin", "password": "correct-horse-battery"})
	resp, err = http.Post("http://"+configuredAddr+"/api/auth/setup", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("environment key precedence: %d", resp.StatusCode)
	}
	_ = configured.Process.Kill()
	_ = configured.Wait()
	configured.Process = nil
	if err = os.WriteFile(path, []byte("POLARIS_CONCURRENCY=2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, fallbackLines := start(filepath.Join(dir, "fallback"), "POLARIS_ADMIN_TOKEN=admin-token")
	fallbackAddr, fallbackLog := readUntilReady(fallbackLines)
	if strings.Contains(fallbackLog, "setup_key=") || strings.Contains(fallbackLog, "admin-token") {
		t.Fatal("fallback key leaked or generated")
	}
	payload, _ = json.Marshal(map[string]string{"credential": "admin-token", "username": "admin", "password": "correct-horse-battery"})
	resp, err = http.Post("http://"+fallbackAddr+"/api/auth/setup", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin token fallback: %d", resp.StatusCode)
	}
	cmd = exec.Command(binary, "--migration", "preview", "--data-dir", dir, "--database-url", filepath.Join(dir, "missing"))
	cmd.Dir = dir
	cmd.Env = environ
	out, _ := cmd.CombinedOutput()
	if strings.Contains(string(out), "setup_key=") || strings.Contains(string(out), "file-secret") {
		t.Fatal("migration leaked setup key")
	}
}
