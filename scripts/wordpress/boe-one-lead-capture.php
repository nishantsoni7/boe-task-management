<?php
/**
 * BOE One: every Contact Form 7 enquiry goes straight to Sales, Lead Master, within seconds.
 *
 * Where: WordPress, WPCode (Code Snippets), + Add Snippet, "Add Your Custom Code", Code type "PHP Snippet".
 *        Insert Method "Auto Insert", Location "Run Everywhere". Paste this whole file, put the key below, Activate, Save.
 *        Live on bestofexports.com since 2026-11-03 as WPCode snippet "BOE One lead capture (website forms to Sales)".
 *        This copy is the record of it, with the key left out: the key lives only in WordPress and in Vercel.
 * Key:   the same value as SALES_CAPTURE_SECRET in Vercel (never share it; it lets a sender add leads).
 *
 * Covers all ten forms on the site. Each enquiry becomes a lead in BOE One (a known number becomes a repeat enquiry on
 * its lead), given to a salesperson by the allotment rule in working hours, or waiting "Not allotted" with whoever allots
 * leads alerted (capture_sales_leads, 20270602000000). Google Ads comes from the form's hidden form-type, or from
 * Google's ad tag in the page link. The form name and the page it was sent from go into the requirement.
 * If BOE One cannot be reached, the form, its email, CFDB7 and the Google Sheet all carry on as before; the failure is
 * written to the PHP error log.
 */

if (!defined('BOE_ONE_CAPTURE_KEY')) {
	define('BOE_ONE_CAPTURE_KEY', 'PASTE-THE-KEY-HERE');
}

add_action('wpcf7_before_send_mail', function ($contact_form) {
	if (!class_exists('WPCF7_Submission') || BOE_ONE_CAPTURE_KEY === 'PASTE-THE-KEY-HERE') {
		return;
	}
	$submission = WPCF7_Submission::get_instance();
	if (!$submission) {
		return;
	}
	$data = $submission->get_posted_data();

	// The first non-empty value among these field names.
	$get = function ($names) use ($data) {
		foreach ((array) $names as $name) {
			if (!isset($data[$name])) {
				continue;
			}
			$value = is_array($data[$name]) ? implode(', ', $data[$name]) : (string) $data[$name];
			$value = trim(wp_strip_all_tags($value));
			if ($value !== '') {
				return $value;
			}
		}
		return '';
	};

	$phone = $get(array('your-tel', 'your-phone', 'tel'));
	if ($phone === '') {
		return;
	}
	$name     = $get('your-name');
	$email    = $get('your-email');
	$page     = (string) $submission->get_meta('url');
	$quantity = $get(array('Quantity', 'quantity'));

	$lines = array_filter(array(
		$get('your-requirement'),
		$quantity !== '' ? 'Quantity: ' . $quantity : '',
		$get(array('your-textarea', 'your-message')),
		'Form: ' . $contact_form->title() . ($page !== '' ? ' (' . $page . ')' : ''),
	));
	$message = implode("\n", $lines);

	$google = stripos($get('form-type'), 'google ads') !== false
		|| preg_match('/[?&](gclid|gbraid|wbraid)=|utm_source=google/i', $page);

	$row = array(
		// One key per submission, so a resend counts once and a second enquiry later is still recorded.
		'key'       => md5(implode('|', array($phone, $email, $name, $message, (string) $submission->get_meta('timestamp')))),
		'form_type' => $google ? 'Google Ads' : $get('form-type'),
		'name'      => $name,
		'email'     => $email,
		'phone'     => $phone,
		'location'  => $get(array('your-location', 'your-city')),
		'message'   => $message,
	);

	$response = wp_remote_post('https://boeone.vercel.app/api/sales/capture/website', array(
		'timeout' => 6,
		'headers' => array(
			'Content-Type'  => 'application/json',
			'Authorization' => 'Bearer ' . BOE_ONE_CAPTURE_KEY,
		),
		'body'    => wp_json_encode(array('rows' => array($row))),
	));
	if (is_wp_error($response)) {
		error_log('BOE One lead capture failed: ' . $response->get_error_message());
	} elseif (wp_remote_retrieve_response_code($response) !== 200) {
		error_log('BOE One lead capture answered ' . wp_remote_retrieve_response_code($response) . ': ' . substr(wp_remote_retrieve_body($response), 0, 200));
	}
});
