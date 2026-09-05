#include "EmailService.h"
#include "../utils/StringUtils.h"

#include <curl/curl.h>
#include <json/json.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>

namespace stackpilot {
namespace {

using strings::trim;

std::string getEnvOrDefault(const char* name, const std::string& fallback = "") {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

std::string collapseWhitespace(std::string value) {
    std::replace_if(value.begin(), value.end(), [](unsigned char c) {
        return c == '\r' || c == '\n';
    }, ' ');
    return trim(value);
}

struct UploadPayload {
    const char* data = nullptr;
    size_t remaining = 0;
};

size_t payloadSource(char* ptr, size_t size, size_t nmemb, void* userData) {
    auto* payload = static_cast<UploadPayload*>(userData);
    const size_t bufferSize = size * nmemb;
    if (!payload || payload->remaining == 0 || bufferSize == 0) {
        return 0;
    }

    const size_t copySize = std::min(bufferSize, payload->remaining);
    std::memcpy(ptr, payload->data, copySize);
    payload->data += copySize;
    payload->remaining -= copySize;
    return copySize;
}

size_t responseCallback(char* ptr, size_t size, size_t nmemb, void* userData) {
    auto* response = static_cast<std::string*>(userData);
    if (!response) return 0;
    response->append(ptr, size * nmemb);
    return size * nmemb;
}

void ensureCurlInitialized() {
    static std::once_flag initFlag;
    std::call_once(initFlag, []() {
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
            throw std::runtime_error("Failed to initialize libcurl");
        }
    });
}

} // namespace

std::string EmailService::getBrevoApiKey() {
    std::string key = trim(getEnvOrDefault("BREVO_API_KEY"));
    if (!key.empty()) return key;
    return trim(getEnvOrDefault("SIB_API_KEY"));
}

bool EmailService::isBrevoConfigured() {
    return !getBrevoApiKey().empty();
}

std::string EmailService::getSmtpHost() {
    return getEnvOrDefault("SMTP_HOST", "smtp-relay.brevo.com");
}

int EmailService::getSmtpPort() {
    const std::string raw = getEnvOrDefault("SMTP_PORT", "587");
    try {
        return std::max(1, std::stoi(raw));
    } catch (...) {
        return 587;
    }
}

std::string EmailService::getSmtpUsername() {
    std::string username = trim(getEnvOrDefault("SMTP_USERNAME"));
    if (!username.empty()) {
        return username;
    }
    username = trim(getEnvOrDefault("BREVO_FROM_EMAIL"));
    if (!username.empty()) {
        return username;
    }
    username = trim(getEnvOrDefault("SMTP_FROM_EMAIL"));
    if (!username.empty()) {
        return username;
    }
    return trim(getEnvOrDefault("ACME_EMAIL", "adiroyboy2@gmail.com"));
}

std::string EmailService::getSmtpPassword() {
    std::string password = getEnvOrDefault("BREVO_API_KEY");
    if (!password.empty()) {
        return password;
    }
    password = getEnvOrDefault("SMTP_PASSWORD");
    if (!password.empty()) {
        return password;
    }
    return getEnvOrDefault("APP_PASSWORD");
}

std::string EmailService::getFromEmail() {
    std::string from = trim(getEnvOrDefault("BREVO_FROM_EMAIL"));
    if (!from.empty()) {
        return from;
    }
    from = trim(getEnvOrDefault("SMTP_FROM_EMAIL"));
    if (!from.empty()) {
        return from;
    }
    return getSmtpUsername();
}

std::string EmailService::getFromName() {
    std::string name = trim(getEnvOrDefault("BREVO_FROM_NAME"));
    if (!name.empty()) {
        return collapseWhitespace(name);
    }
    return collapseWhitespace(getEnvOrDefault("SMTP_FROM_NAME", "StackPilot Platform"));
}

bool EmailService::isConfigured() {
    if (isBrevoConfigured()) return true;
    return !getSmtpHost().empty() &&
           !getSmtpUsername().empty() &&
           !getSmtpPassword().empty() &&
           !getFromEmail().empty();
}

void EmailService::sendViaBrevo(const std::string& toEmail,
                                const std::string& toName,
                                const std::string& subject,
                                const std::string& htmlContent,
                                const std::string& textContent) {
    ensureCurlInitialized();
    const std::string apiKey = getBrevoApiKey();
    const std::string fromEmail = getFromEmail();
    const std::string fromName = getFromName();

    Json::Value root;
    Json::Value sender;
    sender["name"] = fromName;
    sender["email"] = fromEmail;
    root["sender"] = sender;

    Json::Value toList(Json::arrayValue);
    Json::Value recipient;
    recipient["email"] = toEmail;
    if (!toName.empty()) {
        recipient["name"] = toName;
    }
    toList.append(recipient);
    root["to"] = toList;

    root["subject"] = subject;
    root["htmlContent"] = htmlContent;
    if (!textContent.empty()) {
        root["textContent"] = textContent;
    }

    Json::StreamWriterBuilder writer;
    const std::string requestBody = Json::writeString(writer, root);

    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize Brevo HTTP client");
    }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("api-key: " + apiKey).c_str());
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: application/json");

    std::string responseBody;

    curl_easy_setopt(curl, CURLOPT_URL, "https://api.brevo.com/v3/smtp/email");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, requestBody.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, responseCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);

    const CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        spdlog::error("Brevo API delivery failed: {}", curl_easy_strerror(res));
        throw std::runtime_error("Failed to connect to Brevo email service");
    }

    if (httpCode < 200 || httpCode >= 300) {
        spdlog::error("Brevo API responded with HTTP {}: {}", httpCode, responseBody);
        throw std::runtime_error("Brevo email delivery rejected with HTTP " + std::to_string(httpCode));
    }

    spdlog::info("Email sent successfully via Brevo API to {}", toEmail);
}

void EmailService::sendViaSmtp(const std::string& toEmail,
                               const std::string& toName,
                               const std::string& subject,
                               const std::string& textContent) {
    ensureCurlInitialized();

    const std::string smtpHost = getSmtpHost();
    const int smtpPort = getSmtpPort();
    const std::string smtpUsername = getSmtpUsername();
    const std::string smtpPassword = getSmtpPassword();
    const std::string fromEmail = getFromEmail();
    const std::string fromName = getFromName();
    const std::string safeName = collapseWhitespace(toName);

    std::ostringstream body;
    body << "From: " << fromName << " <" << fromEmail << ">\r\n"
         << "To: " << (safeName.empty() ? toEmail : safeName + " <" + toEmail + ">") << "\r\n"
         << "Subject: " << subject << "\r\n"
         << "MIME-Version: 1.0\r\n"
         << "Content-Type: text/plain; charset=UTF-8\r\n"
         << "\r\n"
         << textContent;

    const std::string payloadText = body.str();
    UploadPayload payload{payloadText.c_str(), payloadText.size()};

    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize SMTP client");
    }

    struct curl_slist* recipients = nullptr;
    const std::string smtpUrl = (smtpPort == 465 ? "smtps://" : "smtp://") + smtpHost + ":" + std::to_string(smtpPort);

    recipients = curl_slist_append(recipients, ("<" + toEmail + ">").c_str());

    curl_easy_setopt(curl, CURLOPT_URL, smtpUrl.c_str());
    curl_easy_setopt(curl, CURLOPT_USERNAME, smtpUsername.c_str());
    curl_easy_setopt(curl, CURLOPT_PASSWORD, smtpPassword.c_str());
    curl_easy_setopt(curl, CURLOPT_USE_SSL, static_cast<long>(CURLUSESSL_ALL));
    curl_easy_setopt(curl, CURLOPT_MAIL_FROM, ("<" + fromEmail + ">").c_str());
    curl_easy_setopt(curl, CURLOPT_MAIL_RCPT, recipients);
    curl_easy_setopt(curl, CURLOPT_READFUNCTION, payloadSource);
    curl_easy_setopt(curl, CURLOPT_READDATA, &payload);
    curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    const CURLcode result = curl_easy_perform(curl);
    curl_slist_free_all(recipients);
    curl_easy_cleanup(curl);

    if (result != CURLE_OK) {
        spdlog::error("SMTP delivery failed: {}", curl_easy_strerror(result));
        throw std::runtime_error("Failed to deliver email via SMTP");
    }
}

void EmailService::sendPasswordResetOtp(const std::string& toEmail,
                                        const std::string& toName,
                                        const std::string& otpCode,
                                        int expiryMinutes) {
    if (!isConfigured()) {
        throw std::runtime_error("Email service is not configured for password reset emails");
    }

    const std::string subject = "StackPilot password reset code";
    const std::string text =
        "We received a request to reset your StackPilot account password.\r\n\r\n"
        "Your verification code is: " + otpCode + "\r\n\r\n"
        "This code expires in " + std::to_string(expiryMinutes) + " minutes and can only be used once.\r\n"
        "If you did not request this reset, you can ignore this email.\r\n";

    if (isBrevoConfigured()) {
        const std::string html =
            "<div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #0f172a; color: #f8fafc; border-radius: 12px;\">"
            "<h2 style=\"color: #38bdf8; margin-bottom: 16px;\">StackPilot Password Reset</h2>"
            "<p style=\"font-size: 15px; line-height: 1.5; color: #cbd5e1;\">We received a request to reset your StackPilot account password.</p>"
            "<div style=\"margin: 24px 0; padding: 18px; background: #1e293b; border-radius: 8px; text-align: center;\">"
            "<span style=\"font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #38bdf8; font-family: monospace;\">" + otpCode + "</span>"
            "</div>"
            "<p style=\"font-size: 13px; color: #94a3b8;\">This code expires in " + std::to_string(expiryMinutes) + " minutes. If you did not request this, you can ignore this email.</p>"
            "</div>";
        sendViaBrevo(toEmail, toName, subject, html, text);
    } else {
        sendViaSmtp(toEmail, toName, subject, text);
    }
}

void EmailService::sendOrganizationInvitation(const std::string& toEmail,
                                              const std::string& inviterName,
                                              const std::string& orgName,
                                              const std::string& role,
                                              const std::string& inviteUrl) {
    if (!isConfigured()) {
        spdlog::warn("EmailService not configured, skipping invitation email to {}", toEmail);
        return;
    }

    const std::string subject = "Invitation to join " + orgName + " on StackPilot";
    const std::string text =
        "Hello,\r\n\r\n" +
        inviterName + " has invited you to join the \"" + orgName + "\" organization on StackPilot with the role of " + role + ".\r\n\r\n"
        "To accept this invitation and get started, visit the link below:\r\n" +
        inviteUrl + "\r\n\r\n"
        "This invitation will expire in 7 days.\r\n\r\n"
        "The StackPilot Team\r\n";

    if (isBrevoConfigured()) {
        const std::string html =
            "<div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 36px 28px; background: #0f172a; color: #f8fafc; border-radius: 16px; border: 1px solid #334155;\">"
            "<div style=\"display: flex; align-items: center; margin-bottom: 24px;\">"
            "<h1 style=\"font-size: 22px; font-weight: 700; color: #f8fafc; margin: 0;\">StackPilot</h1>"
            "</div>"
            "<h2 style=\"font-size: 18px; font-weight: 600; color: #38bdf8; margin: 0 0 16px 0;\">You're invited to collaborate</h2>"
            "<p style=\"font-size: 15px; line-height: 1.6; color: #cbd5e1; margin-bottom: 20px;\">"
            "<strong style=\"color: #f8fafc;\">" + inviterName + "</strong> has invited you to join the team workspace <strong style=\"color: #38bdf8;\">" + orgName + "</strong> on StackPilot as a <strong style=\"color: #f8fafc; text-transform: capitalize;\">" + role + "</strong>."
            "</p>"
            "<div style=\"margin: 28px 0; text-align: center;\">"
            "<a href=\"" + inviteUrl + "\" style=\"display: inline-block; background: #0284c7; color: #ffffff; font-weight: 600; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.35);\">Accept Invitation</a>"
            "</div>"
            "<p style=\"font-size: 13px; color: #94a3b8; line-height: 1.5;\">Or copy and paste this URL into your browser:<br/><a href=\"" + inviteUrl + "\" style=\"color: #38bdf8; word-break: break-all;\">" + inviteUrl + "</a></p>"
            "<hr style=\"border: none; border-top: 1px solid #1e293b; margin: 28px 0;\" />"
            "<p style=\"font-size: 12px; color: #64748b; margin: 0;\">This invitation link will expire in 7 days. If you were not expecting this invitation, you can safely ignore this email.</p>"
            "</div>";
        sendViaBrevo(toEmail, "", subject, html, text);
    } else {
        sendViaSmtp(toEmail, "", subject, text);
    }
}

} // namespace stackpilot
