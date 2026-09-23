import { CaptainDashboard } from "@/components/captain-dashboard";

export default async function CaptainPage({ params }: { params: Promise<{ shipId: string }> }) {
  const { shipId } = await params;
  return <CaptainDashboard shipId={shipId.toUpperCase()} />;
}
