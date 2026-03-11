import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BackgroundSlideshow from './components/BackgroundSlideshow';
import Dashboard from './pages/Dashboard';
import './App.css';

function App() {
  return (
    <>
      <BackgroundSlideshow />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}

export default App;
