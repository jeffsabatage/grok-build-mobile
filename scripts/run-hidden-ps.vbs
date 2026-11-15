' Hidden PowerShell launcher. Task Scheduler:
'   wscript.exe //B //Nologo run-hidden-ps.vbs "<script.ps1>" [args...]
' Window style 0 = hidden. Wait=True so the task tracks the process.
Option Explicit
Dim sh, fso, script, extra, i, folder, cmd, rc
If WScript.Arguments.Count < 1 Then WScript.Quit 1
script = WScript.Arguments(0)
extra = ""
For i = 1 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(i)
Next
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(script) Then WScript.Quit 2
folder = fso.GetParentFolderName(script)
Set sh = CreateObject("WScript.Shell")
If folder <> "" Then sh.CurrentDirectory = folder
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """" & extra
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
