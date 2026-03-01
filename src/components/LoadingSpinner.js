import React from 'react';
import { Spinner } from 'react-bootstrap';

const LoadingSpinner = () => {
  return (
    <div className="loading-spinner">
      <Spinner animation="border" variant="primary" />
      <span className="ms-3 text-muted">Загрузка данных...</span>
    </div>
  );
};

export default LoadingSpinner;
