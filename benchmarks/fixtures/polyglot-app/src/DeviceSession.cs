using static System.Math;
using Builder = System.Text.StringBuilder;

public sealed class DeviceSession {
  public int ClampLevel(int value) => Min(value, 10);
}
