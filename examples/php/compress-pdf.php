<?php
// Compress a PDF with the editpdf.tools Compress PDF API (PHP 8 + cURL).
//
//   EDITPDF_API_KEY=ept_... php compress-pdf.php input.pdf [light|recommended|strong]
//
// Free plan: 30 files per month, up to 10 MB each, 1 file per minute.
// Docs: https://editpdf.tools/compress-pdf-api

$api   = (getenv('EDITPDF_API_BASE') ?: 'https://api.editpdf.tools') . '/v1/compress';
$key   = getenv('EDITPDF_API_KEY') ?: exit("Set EDITPDF_API_KEY first (free key: https://api.editpdf.tools/signup)\n");
$input = $argv[1] ?? exit("Usage: php compress-pdf.php input.pdf [level]\n");
$level = $argv[2] ?? 'recommended';

$headers = [];
$ch = curl_init($api);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ['X-API-Key: ' . $key],
    CURLOPT_POSTFIELDS     => ['file' => new CURLFile($input, 'application/pdf', basename($input)), 'level' => $level],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 180,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$headers) {
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        return strlen($line);
    },
]);
$body   = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($status !== 200) {
    $err = json_decode($body, true) ?: ['error' => "HTTP $status"];
    $wait = $headers['retry-after'] ?? null;
    exit(($err['message'] ?? $err['error']) . ($wait ? " (retry after {$wait}s)" : '') . "\n");
}

$out = preg_replace('/\.pdf$/i', '', $input) . '-compressed.pdf';
file_put_contents($out, $body);
printf("%s: %s -> %s bytes, %s files left this month\n",
    $out, $headers['x-original-size'], $headers['x-compressed-size'], $headers['x-quota-remaining']);
