// 验证通知动作与消息内容。
// Check notification actions and message content.

package polaris

import (
	"strings"
	"testing"
)

func TestNotificationNormalActions(t *testing.T) {
	cases := []struct {
		name        string
		previous    any
		monitorType string
		eventKey    string
		actionKey   string
	}{
		{"first normal reading", nil, "http", "", "actionUpCurrent"},
		{"normal without transition", 1, "http", "", "actionUpCurrent"},
		{"failure recovery", 0, "http", "", "actionUp"},
		{"warning recovery", 2, "http", "", "actionUp"},
		{"agent resource recovery", 2, "agent", "resource:cpu:recovery", "actionUp"},
	}
	for language, copy := range notificationCopy {
		for _, tc := range cases {
			t.Run(language+"/"+tc.name, func(t *testing.T) {
				event := Object{"monitorName": "example", "monitorType": tc.monitorType, "eventKey": tc.eventKey, "status": 1, "prevStatus": tc.previous}
				_, message := notificationMessage(event, Object{"language": language})
				action := formatCopy(str(copy, "action"), map[string]string{"value": str(copy, tc.actionKey)})
				if !strings.Contains(message, action) {
					t.Fatalf("missing action %q in %q", action, message)
				}
			})
		}
	}
}
