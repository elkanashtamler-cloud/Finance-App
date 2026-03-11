import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const SLIDE_INTERVAL_MS = 6000;

// Add image filenames here; place files in public/backgrounds/
const BACKGROUND_IMAGES = [
  '/backgrounds/1.jpg',
  '/backgrounds/2.jpg',
  '/backgrounds/3.jpg',
];

const DEFAULT_GRADIENT = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)';

export default function BackgroundSlideshow() {
  const [index, setIndex] = useState(0);

  const images = BACKGROUND_IMAGES.length > 0 ? BACKGROUND_IMAGES : [];
  const currentSrc = images[index];

  useEffect(() => {
    if (images.length <= 1) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % images.length);
    }, SLIDE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [images.length]);

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden">
      {/* Base gradient (always visible as fallback) */}
      <div
        className="absolute inset-0"
        style={{ background: DEFAULT_GRADIENT }}
      />

      <AnimatePresence mode="wait">
        {currentSrc && (
          <motion.div
            key={currentSrc + index}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.2 }}
          >
            <img
              src={currentSrc}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                e.target.style.display = 'none';
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/40" aria-hidden />
    </div>
  );
}
