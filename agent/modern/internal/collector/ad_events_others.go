//go:build (!windows) && !noad

package collector

// ReadADEvents is a no-op on non-Windows systems.
func ReadADEvents(hours int) []ADEvent {
	return nil
}
