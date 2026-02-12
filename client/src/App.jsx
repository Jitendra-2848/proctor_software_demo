import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Room from './pages/room'
import Proctoring from './pages/proctoring'

const App = () => {
  return (
    <div>
      <Routes>
        <Route path='/room/:id' element={<Room />} />
        <Route path='/proctoring' element={<Proctoring />} />
      </Routes>
    </div>
  )
}

export default App