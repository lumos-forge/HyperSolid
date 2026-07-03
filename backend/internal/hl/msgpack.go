package hl

import (
	"encoding/binary"
	"fmt"
)

// KV is one ordered key/value pair.
type KV struct {
	K string
	V any
}

// Map is an insertion-ordered map (msgpack map key order is byte-significant for HL).
type Map []KV

// Encode serializes v as msgpack, matching @std/msgpack for the value shapes HL actions use:
// string, int64, uint64, bool, []any (array), and Map (ordered map). No floats.
func Encode(v any) ([]byte, error) {
	var b []byte
	if err := enc(&b, v); err != nil {
		return nil, err
	}
	return b, nil
}

func enc(b *[]byte, v any) error {
	switch x := v.(type) {
	case string:
		encStr(b, x)
	case bool:
		if x {
			*b = append(*b, 0xc3)
		} else {
			*b = append(*b, 0xc2)
		}
	case int64:
		encInt(b, x)
	case uint64:
		encUint(b, x)
	case []any:
		encArrayHeader(b, len(x))
		for _, e := range x {
			if err := enc(b, e); err != nil {
				return err
			}
		}
	case Map:
		encMapHeader(b, len(x))
		for _, kv := range x {
			encStr(b, kv.K)
			if err := enc(b, kv.V); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("msgpack: unsupported type %T", v)
	}
	return nil
}

func encStr(b *[]byte, s string) {
	n := len(s)
	switch {
	case n < 32:
		*b = append(*b, 0xa0|byte(n))
	case n < 256:
		*b = append(*b, 0xd9, byte(n))
	default:
		*b = append(*b, 0xdb)
		*b = binary.BigEndian.AppendUint16(*b, uint16(n))
	}
	*b = append(*b, s...)
}

func encInt(b *[]byte, n int64) {
	if n >= 0 {
		encUint(b, uint64(n))
		return
	}
	switch {
	case n >= -32:
		*b = append(*b, byte(n))
	case n >= -128:
		*b = append(*b, 0xd0, byte(int8(n)))
	case n >= -32768:
		*b = append(*b, 0xd1)
		*b = binary.BigEndian.AppendUint16(*b, uint16(int16(n)))
	case n >= -2147483648:
		*b = append(*b, 0xd2)
		*b = binary.BigEndian.AppendUint32(*b, uint32(int32(n)))
	default:
		*b = append(*b, 0xd3)
		*b = binary.BigEndian.AppendUint64(*b, uint64(n))
	}
}

func encUint(b *[]byte, n uint64) {
	switch {
	case n < 128:
		*b = append(*b, byte(n))
	case n < 256:
		*b = append(*b, 0xcc, byte(n))
	case n < 65536:
		*b = append(*b, 0xcd)
		*b = binary.BigEndian.AppendUint16(*b, uint16(n))
	case n < 4294967296:
		*b = append(*b, 0xce)
		*b = binary.BigEndian.AppendUint32(*b, uint32(n))
	default:
		*b = append(*b, 0xcf)
		*b = binary.BigEndian.AppendUint64(*b, n)
	}
}

func encArrayHeader(b *[]byte, n int) {
	if n < 16 {
		*b = append(*b, 0x90|byte(n))
		return
	}
	*b = append(*b, 0xdc)
	*b = binary.BigEndian.AppendUint16(*b, uint16(n))
}

func encMapHeader(b *[]byte, n int) {
	if n < 16 {
		*b = append(*b, 0x80|byte(n))
		return
	}
	*b = append(*b, 0xde)
	*b = binary.BigEndian.AppendUint16(*b, uint16(n))
}
