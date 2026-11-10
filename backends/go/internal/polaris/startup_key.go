package polaris

import (
	"crypto/rand"
	"encoding/base64"
)

// GenerateSetupKey 仅在尚未初始化且未配置初始化凭据时生成进程内密钥。
// GenerateSetupKey creates an in-memory key only before setup and without configured setup credentials.
func (a *App) GenerateSetupKey() (string, error) {
	a.storeLock.Lock()
	defer a.storeLock.Unlock()
	if a.config.SetupKey != "" || a.config.AdminToken != "" {
		return "", nil
	}
	select {
	case <-a.setupReady:
		return "", nil
	default:
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	key := base64.RawURLEncoding.EncodeToString(secret)
	a.config.SetupKey = key
	return key, nil
}
