// 验证 UDP 只有收到数据报才判为成功。
// Check that UDP succeeds only after receiving a datagram.

package polaris

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestUDPRequiresAReceivedDatagram(t *testing.T) {
	s := newTestServer(t)
	fixtures := []struct {
		name    string
		reply   bool
		payload []byte
		options Object
		status  int
	}{
		{name: "silence", options: Object{}, status: 0},
		{name: "any_response", reply: true, payload: []byte("pong"), options: Object{}, status: 1},
		{name: "empty_datagram", reply: true, payload: []byte{}, options: Object{}, status: 1},
		{name: "matching_hex", reply: true, payload: []byte{0xde, 0xad, 0xbe, 0xef}, options: Object{"send": "70696e67", "expect": "dead", "encoding": "hex"}, status: 1},
		{name: "short_reply_mismatch", reply: true, payload: []byte("pon"), options: Object{"expect": "pong"}, status: 0},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			conn, err := net.ListenPacket("udp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			received := make(chan struct{})
			go func() {
				buffer := make([]byte, 4096)
				_, address, err := conn.ReadFrom(buffer)
				if err != nil {
					return
				}
				close(received)
				if fixture.reply {
					_, _ = conn.WriteTo(fixture.payload, address)
				}
			}()
			result := s.app.probe(context.Background(), Object{"type": "udp", "target": conn.LocalAddr().String(), "timeout_ms": 150, "options_json": encode(fixture.options)})
			select {
			case <-received:
			case <-time.After(time.Second):
				t.Fatal("loopback fixture did not receive the probe")
			}
			if result.Status != fixture.status {
				t.Fatalf("UDP status = %d, want %d: %+v", result.Status, fixture.status, result)
			}
		})
	}
}
