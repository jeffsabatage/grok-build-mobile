# Type text into a live grok.exe console via WriteConsoleInput (no window-title
# guess, no clipboard). AttachConsole(pid) then KEY_EVENT records + Enter.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [switch]$Probe
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class TuiCon {
  public const ushort KEY_EVENT = 1;
  public const short VK_RETURN = 0x0D;

  [StructLayout(LayoutKind.Explicit, Size = 20)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public ushort UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] buf, uint n, out uint written);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();

  static INPUT_RECORD Key(char ch, short vk, bool down) {
    var r = new INPUT_RECORD();
    r.EventType = KEY_EVENT;
    r.bKeyDown = down ? 1 : 0;
    r.wRepeatCount = 1;
    r.wVirtualKeyCode = (ushort)vk;
    r.wVirtualScanCode = 0;
    r.UnicodeChar = ch;
    r.dwControlKeyState = 0;
    return r;
  }

  public static string Probe(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach fail win32=" + Marshal.GetLastWin32Error();
    IntPtr h = GetStdHandle(-10);
    IntPtr hwnd = GetConsoleWindow();
    FreeConsole();
    if (h == IntPtr.Zero || h == (IntPtr)(-1)) return "stdin fail hwnd=" + hwnd;
    return "ok hwnd=" + hwnd + " stdin=" + h;
  }

  public static string Type(uint pid, string text, bool submit) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach fail win32=" + Marshal.GetLastWin32Error();
    try {
      IntPtr h = GetStdHandle(-10);
      if (h == IntPtr.Zero || h == (IntPtr)(-1)) return "stdin fail win32=" + Marshal.GetLastWin32Error();
      int extra = submit ? 2 : 0;
      int n = text.Length * 2 + extra;
      var buf = new INPUT_RECORD[n];
      int i = 0;
      foreach (char ch in text) {
        buf[i++] = Key(ch, 0, true);
        buf[i++] = Key(ch, 0, false);
      }
      if (submit) {
        buf[i++] = Key('\r', VK_RETURN, true);
        buf[i++] = Key('\r', VK_RETURN, false);
      }
      uint written;
      if (!WriteConsoleInput(h, buf, (uint)i, out written)) {
        return "write fail win32=" + Marshal.GetLastWin32Error();
      }
      return "ok wrote=" + written;
    } finally {
      FreeConsole();
    }
  }
}
"@

if ($Probe) {
  $r = [TuiCon]::Probe([uint32]$ProcessId)
  Write-Output $r
  if ($r -notlike 'ok*') { exit 1 }
  exit 0
}

$TextFile = $env:TUI_TYPE_FILE
if ($TextFile -and (Test-Path -LiteralPath $TextFile)) {
  $Text = [System.IO.File]::ReadAllText($TextFile)
} else {
  $Text = [Console]::In.ReadToEnd()
}
if (-not $Text) { throw "empty text" }
$Text = $Text -replace "`r`n", " " -replace "`n", " " -replace "`r", " "
$submit = $env:TUI_TYPE_SUBMIT -ne "0"
$r = [TuiCon]::Type([uint32]$ProcessId, $Text, $submit)
Write-Output $r
if ($r -notlike 'ok*') { exit 1 }
exit 0
