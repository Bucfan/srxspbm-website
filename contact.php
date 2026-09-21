<?php
// ─────────────────────────────────────────────
//  SRxS Contact Form Mailer
//  Upload this file to your GoDaddy public_html
//  alongside your HTML files.
// ─────────────────────────────────────────────

// ★ CHANGE THIS to your actual email address
$to_email = "info@simplifiedrxsolutions.com";
$site_name = "SRxS – Simplified RX Solutions";

// Backup copy of every lead, sent as a separate message so a delivery problem
// on $to_email can never lose a submission.
//
// The address is not hardcoded here: this repo is public. Set it in
// srxs-mail-config.php in the hosting account's home directory (above the
// document root, never committed):
//
//     <?php $backup_email = "someone@example.com";
//
// If that file is absent, the backup copy is simply disabled.
$backup_email = "";
$mail_config = __DIR__ . "/../../srxs-mail-config.php";
if (is_readable($mail_config)) {
    include $mail_config;
}

// Every submission is also written to disk. The log lives ABOVE the document
// root so it is never reachable over the web (it contains customer contact
// details). Resolves to the hosting account's home directory.
$log_file = __DIR__ . "/../../srxs-contact-submissions.log";

/**
 * Append one line to the submission log. Never fatal: if the log cannot be
 * written the form must still work.
 */
function log_submission($log_file, $entry) {
    $line = "[" . gmdate('Y-m-d H:i:s') . " UTC] " . $entry . "\n";
    return @file_put_contents($log_file, $line, FILE_APPEND | LOCK_EX) !== false;
}

// Only accept POST requests
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

// Sanitize inputs
function clean($value) {
    return htmlspecialchars(strip_tags(trim($value)), ENT_QUOTES, 'UTF-8');
}

$name    = clean($_POST['name']    ?? '');
$email   = clean($_POST['email']   ?? '');
$phone   = clean($_POST['phone']   ?? '');
$message = clean($_POST['message'] ?? '');

// Basic validation
if (empty($name) || empty($email) || empty($message)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Name, email, and message are required.']);
    exit;
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid email address.']);
    exit;
}

// Build email
$subject = "New Contact Form Submission – $site_name";

$body = "
You have received a new message from the $site_name website contact form.

────────────────────────────────
Name:    $name
Email:   $email
Phone:   " . ($phone ?: 'Not provided') . "
────────────────────────────────

Message:
$message

────────────────────────────────
Sent from: $site_name contact form
";

$headers  = "From: SRxS Website <noreply@simplifiedrxsolutions.com>\r\n";
$headers .= "Reply-To: $email\r\n";
$headers .= "MIME-Version: 1.0\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
$headers .= "Message-ID: <" . time() . '.' . md5($email . $message) . "@simplifiedrxsolutions.com>\r\n";
$headers .= "X-Mailer: PHP/" . phpversion();

// Record the lead BEFORE attempting delivery, so it survives any mail failure.
$logged = log_submission($log_file, sprintf(
    "SUBMISSION | name=%s | email=%s | phone=%s | ip=%s | message=%s",
    $name, $email, ($phone ?: '-'), ($_SERVER['REMOTE_ADDR'] ?? '-'),
    str_replace(["\r", "\n"], ' ', $message)
));

// Send the email. The -f envelope sender makes SPF align with the From domain.
$sent = mail($to_email, $subject, $body, $headers, "-fnoreply@simplifiedrxsolutions.com");

// Send an independent backup copy. This is a separate delivery, so it arrives
// even when mail to $to_email is misrouted or silently discarded downstream.
$sent_backup = null;
if ($backup_email !== "") {
    $backup_headers  = "From: SRxS Website <noreply@simplifiedrxsolutions.com>\r\n";
    $backup_headers .= "Reply-To: $email\r\n";
    $backup_headers .= "MIME-Version: 1.0\r\n";
    $backup_headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $backup_headers .= "X-Mailer: PHP/" . phpversion();
    $sent_backup = mail(
        $backup_email,
        "[Lead copy] $subject",
        "This is a backup copy of a lead also sent to $to_email.\n$body",
        $backup_headers,
        "-fnoreply@simplifiedrxsolutions.com"
    );
}

// mail() returning true only means the message was accepted by the local mail
// server — it is NOT proof of delivery. Log both results so a silent failure
// downstream is diagnosable after the fact.
log_submission($log_file, sprintf(
    "DELIVERY   | to=%s handoff=%s | backup=%s handoff=%s | logged=%s",
    $to_email, ($sent ? 'accepted' : 'REFUSED'),
    ($backup_email ?: '-'),
    ($sent_backup === null ? 'disabled' : ($sent_backup ? 'accepted' : 'REFUSED')),
    ($logged ? 'yes' : 'NO')
));

// The lead is safely captured if it reached any mailbox or the log file.
$captured = $sent || $sent_backup || $logged;

// Send auto-reply to the person who submitted
if ($captured) {
    $reply_subject = "We received your message – $site_name";
    $reply_body = "
Hi $name,

Thank you for reaching out to SRxS – Simplified RX Solutions!

We've received your message and a member of our team will be in touch with you shortly.

Here's a copy of what you sent us:
────────────────────────────────
$message
────────────────────────────────

In the meantime, you can learn more about our services at simplifiedrxsolutions.com.

Best regards,
The SRxS Team
";
    $reply_headers  = "From: SRxS – Simplified RX Solutions <noreply@simplifiedrxsolutions.com>\r\n";
    $reply_headers .= "Reply-To: $to_email\r\n";
    $reply_headers .= "MIME-Version: 1.0\r\n";
    $reply_headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    mail($email, $reply_subject, $reply_body, $reply_headers, "-fnoreply@simplifiedrxsolutions.com");
}

header('Content-Type: application/json');
if ($captured) {
    echo json_encode(['success' => true, 'message' => 'Message sent successfully.']);
} else {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to send email. Please try again.']);
}
?>
