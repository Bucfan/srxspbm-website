<?php
// ─────────────────────────────────────────────
//  SRxS Contact Form Mailer
//  Upload this file to your GoDaddy public_html
//  alongside your HTML files.
// ─────────────────────────────────────────────

// ★ CHANGE THIS to your actual email address
$to_email = "info@simplifiedrxsolutions.com";
$site_name = "SRxS – Simplified RX Solutions";

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

$headers  = "From: SRxS Website <noreply@srxspbm.com>\r\n";
$headers .= "Reply-To: $email\r\n";
$headers .= "X-Mailer: PHP/" . phpversion();

// Send the email
$sent = mail($to_email, $subject, $body, $headers);

// Send auto-reply to the person who submitted
if ($sent) {
    $reply_subject = "We received your message – $site_name";
    $reply_body = "
Hi $name,

Thank you for reaching out to SRxS – Simplified RX Solutions!

We've received your message and a member of our team will be in touch with you shortly.

Here's a copy of what you sent us:
────────────────────────────────
$message
────────────────────────────────

In the meantime, you can learn more about our services at srxspbm.com.

Best regards,
The SRxS Team
";
    $reply_headers  = "From: SRxS – Simplified RX Solutions <noreply@srxspbm.com>\r\n";
    $reply_headers .= "Reply-To: $to_email\r\n";
    mail($email, $reply_subject, $reply_body, $reply_headers);
}

header('Content-Type: application/json');
if ($sent) {
    echo json_encode(['success' => true, 'message' => 'Message sent successfully.']);
} else {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Failed to send email. Please try again.']);
}
?>
