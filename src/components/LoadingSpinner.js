import React from 'react';
import { Spinner } from 'react-bootstrap';

const LoadingSpinner = () => {
  return (
    <div className="loading-spinner">
      <Spinner animation="border" variant="primary" />
      <span className="ms-3 text-muted">
        Price Hunter ищет данные...
      </span>
    </div>
  );
};

export default LoadingSpinner;
