import Recorder from "@/components/Recorder";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New recording</h1>
        <p className="text-sm text-gray-400">
          Record your screen, your camera, or both, with your microphone and system audio.
        </p>
      </div>
      <Recorder />
    </div>
  );
}
