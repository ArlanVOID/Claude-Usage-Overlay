# Creates the "Claude Usage Overlay" launcher (with logo.ico) in the project folder.
$dir = Split-Path -Parent $PSScriptRoot
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut("$dir\Claude Usage Overlay.lnk")
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$dir\Iniciar Overlay.vbs`""
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = "$dir\logo.ico,0"
$lnk.Description = "Claude Usage Overlay"
$lnk.Save()
Write-Host "Atalho criado: $dir\Claude Usage Overlay.lnk"
