import { Navbar } from '@/components/landing/Navbar';
import { Hero } from '@/components/landing/Hero';
import { Features } from '@/components/landing/Features';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { TechStack } from '@/components/landing/TechStack';
import { CTA } from '@/components/landing/CTA';
import { ToastDemo } from '@/components/ToastDemo';
import { Footer } from '@/components/landing/Footer';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';

export default function LandingPage() {
  return (
    <ProtectedRoute mode="unauthenticated">
      <>
        <Navbar />
        <main>
          <Hero />
          <Features />
          <HowItWorks />
          <TechStack />
          <ToastDemo />
          <CTA />
        </main>
        <Footer />
      </>
    </ProtectedRoute>
  );
}
