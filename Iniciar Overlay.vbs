' Inicia o Claude Usage Overlay sem abrir janela de console.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
On Error Resume Next
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0
sh.Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 0, False
