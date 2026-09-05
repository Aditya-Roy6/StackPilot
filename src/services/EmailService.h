#pragma once

#include <string>

namespace stackpilot {

class EmailService {
public:
    static bool isConfigured();
    static bool isBrevoConfigured();
    static void sendPasswordResetOtp(const std::string& toEmail,
                                     const std::string& toName,
                                     const std::string& otpCode,
                                     int expiryMinutes);
    static void sendOrganizationInvitation(const std::string& toEmail,
                                           const std::string& inviterName,
                                           const std::string& orgName,
                                           const std::string& role,
                                           const std::string& inviteUrl);

private:
    static std::string getBrevoApiKey();
    static std::string getSmtpHost();
    static int getSmtpPort();
    static std::string getSmtpUsername();
    static std::string getSmtpPassword();
    static std::string getFromEmail();
    static std::string getFromName();

    static void sendViaBrevo(const std::string& toEmail,
                             const std::string& toName,
                             const std::string& subject,
                             const std::string& htmlContent,
                             const std::string& textContent);
    static void sendViaSmtp(const std::string& toEmail,
                            const std::string& toName,
                            const std::string& subject,
                            const std::string& textContent);
};

} // namespace stackpilot
