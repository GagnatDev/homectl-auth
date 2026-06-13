import { Routes, Route } from 'react-router-dom';
import { LoginPage } from '@/pages/login';
import { InvitePage } from '@/pages/invite';
import { ResetPasswordPage } from '@/pages/reset-password';
import { ConfirmationPage } from '@/pages/confirmation';
import { AdminLoginPage } from '@/pages/admin-login';
import { UsersPage } from '@/pages/users';
import { UserDetailPage } from '@/pages/user-detail';
import { AdminInvitePage } from '@/pages/admin-invite';
import { NotFoundPage } from '@/pages/not-found';

export default function App() {
  return (
    <Routes>
      {/* Public OAuth flow */}
      <Route path="/" element={<ConfirmationPage />} />
      <Route path="/authorize" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Admin */}
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin" element={<UsersPage />} />
      <Route path="/admin/users/:id" element={<UserDetailPage />} />
      <Route path="/admin/invite" element={<AdminInvitePage />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
