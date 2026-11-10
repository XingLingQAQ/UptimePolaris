//go:build !windows

package polaris

import "os"

func replaceDatabaseConfig(source, destination string) error { return os.Rename(source, destination) }
