package hl

import (
	"bytes"
	"testing"
)

func TestEncodePrimitives(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want []byte
	}{
		{"str-fix", "hi", []byte{0xa2, 'h', 'i'}},
		{"str8-32chars", string(bytes.Repeat([]byte("a"), 32)), append([]byte{0xd9, 0x20}, bytes.Repeat([]byte("a"), 32)...)},
		{"int-0", int64(0), []byte{0x00}},
		{"int-127", int64(127), []byte{0x7f}},
		{"int-128", int64(128), []byte{0xcc, 0x80}},
		{"int-256", int64(256), []byte{0xcd, 0x01, 0x00}},
		{"int-65536", int64(65536), []byte{0xce, 0x00, 0x01, 0x00, 0x00}},
		{"int-2^32", int64(4294967296), []byte{0xcf, 0, 0, 0, 1, 0, 0, 0, 0}},
		{"int-neg1", int64(-1), []byte{0xff}},
		{"int-neg32", int64(-32), []byte{0xe0}},
		{"int-neg33", int64(-33), []byte{0xd0, 0xdf}},
		{"bool-true", true, []byte{0xc3}},
		{"bool-false", false, []byte{0xc2}},
		{"array", []any{int64(1), int64(2)}, []byte{0x92, 0x01, 0x02}},
		{"map", Map{{"a", int64(0)}, {"b", true}}, []byte{0x82, 0xa1, 'a', 0x00, 0xa1, 'b', 0xc3}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Encode(c.in)
			if err != nil {
				t.Fatalf("Encode error: %v", err)
			}
			if !bytes.Equal(got, c.want) {
				t.Fatalf("Encode(%v) = %x, want %x", c.in, got, c.want)
			}
		})
	}
}
