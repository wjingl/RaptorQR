# Transfer Hub portable static server.
# English-only on purpose: avoids PowerShell 5.1 code-page parsing issues.
# Uses Windows built-in .NET HttpListener - no Python/Node install needed.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Ask the OS for a free localhost port (never a fixed port like 8080).
$probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()

$mime = @{
    '.html'        = 'text/html; charset=utf-8'
    '.js'          = 'text/javascript; charset=utf-8'
    '.mjs'         = 'text/javascript; charset=utf-8'
    '.css'         = 'text/css; charset=utf-8'
    '.json'        = 'application/json'
    '.webmanifest' = 'application/manifest+json'
    '.wasm'        = 'application/wasm'
    '.svg'         = 'image/svg+xml'
    '.png'         = 'image/png'
    '.ico'         = 'image/x-icon'
    '.txt'         = 'text/plain; charset=utf-8'
    '.md'          = 'text/plain; charset=utf-8'
    '.ps1'         = 'text/plain'
    '.bat'         = 'text/plain'
    '.zip'         = 'application/zip'
}

Write-Host ""
Write-Host "  Transfer Hub portable server started"
Write-Host "  Local URL: http://127.0.0.1:$port/"
Write-Host "  LAN sharing: other devices need HTTPS for the camera."
Write-Host "  Close this window to stop the server."
Write-Host ""
try { Start-Process "http://127.0.0.1:$port/" } catch {}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    try {
        $request = $context.Request
        $relative = [Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
        if ($relative -eq '') { $relative = 'index.html' }
        $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
        $rootFull = [IO.Path]::GetFullPath($root)
        if (-not $file.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
            $file = Join-Path $rootFull 'index.html'
        }
        if (Test-Path $file -PathType Container) { $file = Join-Path $file 'index.html' }
        if (-not (Test-Path $file)) {
            $response.StatusCode = 404
            $response.Close()
            continue
        }
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $contentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($file)
        $response.ContentType = $contentType
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
        $response.StatusCode = 500
    } finally {
        try { $response.Close() } catch {}
    }
}
